import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'legal-documents/manifest.json')
const apply = process.argv.includes('--apply')

function readEnv(text) {
  return Object.fromEntries(
    text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      }),
  )
}

function parseJSONOutput(stdout, command) {
  const text = stdout.trim()
  // Some mutations (set-default, commit, publish) succeed with an empty body.
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    const start = Math.min(
      ...['{', '['].map(token => {
        const index = text.indexOf(token)
        return index < 0 ? Number.POSITIVE_INFINITY : index
      }),
    )
    if (Number.isFinite(start)) {
      try {
        return JSON.parse(text.slice(start))
      } catch {}
    }
    throw new Error(`AGS CLI returned non-JSON output for: ags ${command.join(' ')}`)
  }
}

function runAgs(command, { mutate = false, allowFailure = false } = {}) {
  if (mutate && !apply) {
    console.log(`[plan] ags ${command.join(' ')}`)
    return null
  }

  const args = [
    ...command,
    '--format', 'json',
    '--output', '-',
  ]
  const result = spawnSync('ags', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    if (allowFailure) return null
    throw new Error(
      `ags ${command.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`,
    )
  }
  // `?? true`: an empty body is a SUCCESS with no payload (set-default, publish,
  // commit), so callers can treat null strictly as failure under allowFailure.
  return parseJSONOutput(result.stdout, command) ?? true
}

function objectsIn(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, found)
    return found
  }
  found.push(value)
  for (const item of Object.values(value)) objectsIn(item, found)
  return found
}

function findObject(value, predicate, label) {
  const object = objectsIn(value).find(predicate)
  if (!object) throw new Error(`Could not find ${label} in the AGS response.`)
  return object
}

function optionalObject(value, predicate) {
  return objectsIn(value).find(predicate) || null
}

function idOf(value, label) {
  const object = findObject(value, item => typeof item.id === 'string' && item.id, label)
  return object.id
}

function jsonBody(body) {
  return ['--json', JSON.stringify(body)]
}

async function uploadAttachment(localizedVersionId, source, contentType, namespace) {
  const bytes = await readFile(source)
  const contentMD5 = createHash('md5').update(bytes).digest('base64')
  const response = runAgs([
    'legal', 'localized-versions', 'generate-upload-url',
    '--localized-policy-version-id', localizedVersionId,
    '--namespace', namespace,
    ...jsonBody({ contentMD5, contentType }),
  ], { mutate: true })
  if (!apply) return { contentMD5 }

  const upload = findObject(
    response,
    item => typeof item.attachmentUploadUrl === 'string' && item.attachmentUploadUrl,
    'attachment upload URL',
  )
  const uploaded = await fetch(upload.attachmentUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-MD5': contentMD5,
    },
    body: bytes,
  })
  if (!uploaded.ok) {
    throw new Error(`Attachment upload failed with HTTP ${uploaded.status}.`)
  }

  // The versioned S3 bucket returns the object version as x-amz-version-id; AGS
  // requires it as attachmentVersionIdentifier when linking the attachment.
  const attachmentVersionIdentifier =
    uploaded.headers.get('x-amz-version-id') ||
    upload.attachmentVersionIdentifier ||
    ''

  runAgs([
    'legal', 'localized-versions', 'update',
    '--localized-policy-version-id', localizedVersionId,
    '--namespace', namespace,
    ...jsonBody({
      attachmentChecksum: upload.attachmentChecksum || contentMD5,
      attachmentLocation: upload.attachmentLocation,
      attachmentVersionIdentifier,
      contentType,
    }),
  ], { mutate: true })
  return {
    contentMD5,
    attachmentLocation: upload.attachmentLocation,
  }
}

async function ensureDocument({
  document,
  manifest,
  legalTypeId,
  namespace,
  clientId,
}) {
  const source = resolve(root, 'legal-documents', document.source)
  const contentType = 'text/markdown'
  const sourceBytes = await readFile(source)
  const expectedMD5 = createHash('md5').update(sourceBytes).digest('base64')
  console.log(`\n${document.policyName} ${manifest.displayVersion}`)

  let basePolicies = runAgs([
    'legal', 'base-policies', 'list',
    '--namespace', namespace,
    '--limit', '100',
    '--offset', '0',
  ])
  let basePolicy = optionalObject(
    basePolicies,
    item => item.basePolicyName === document.basePolicyName,
  )
  if (!basePolicy) {
    const created = runAgs([
      'legal', 'base-policies', 'create',
      '--namespace', namespace,
      ...jsonBody({
        affectedClientIds: [clientId],
        affectedCountries: [manifest.countryCode],
        basePolicyName: document.basePolicyName,
        countryType: 'COUNTRY',
        description: document.description,
        isHidden: false,
        isHiddenPublic: false,
        tags: ['ethans-chess', 'apple-submission', document.key],
        typeId: legalTypeId,
      }),
    ], { mutate: true })
    if (!apply) return
    basePolicy = { id: idOf(created, 'created base policy') }
    console.log(`  created base policy ${basePolicy.id}`)
  } else {
    console.log(`  base policy ${basePolicy.id}`)
  }

  const children = runAgs([
    'legal', 'base-policies', 'list-children',
    '--base-policy-id', basePolicy.id,
    '--namespace', namespace,
  ])
  // Creating the base policy auto-creates the country child (named after the
  // base policy, not document.policyName), so match on countryCode — there is
  // exactly one child policy per country.
  let policy = optionalObject(children, item => item.countryCode === manifest.countryCode)
  if (!policy) {
    const created = runAgs([
      'legal', 'base-policies', 'create-child',
      '--base-policy-id', basePolicy.id,
      '--namespace', namespace,
      ...jsonBody({
        countries: [manifest.countryCode],
        countryCode: manifest.countryCode,
        countryType: 'COUNTRY',
        description: document.description,
        isDefaultSelection: true,
        isMandatory: true,
        policyName: document.policyName,
        shouldNotifyOnUpdate: true,
      }),
    ], { mutate: true })
    if (!apply) return
    policy = { id: idOf(created, 'created country policy') }
    console.log(`  created policy ${policy.id}`)
  } else {
    console.log(`  policy ${policy.id}`)
  }

  const versions = runAgs([
    'legal', 'versions', 'list',
    '--namespace', namespace,
    '--policy-id', policy.id,
  ])
  let version = optionalObject(
    versions,
    item => item.displayVersion === manifest.displayVersion && typeof item.id === 'string',
  )
  if (!version) {
    const created = runAgs([
      'legal', 'versions', 'create',
      '--namespace', namespace,
      '--policy-id', policy.id,
      ...jsonBody({
        description: document.description,
        displayVersion: manifest.displayVersion,
        isCommitted: false,
      }),
    ], { mutate: true })
    if (!apply) return
    version = findObject(created, item => typeof item.id === 'string', 'created policy version')
    console.log(`  created version ${version.id}`)
  } else {
    console.log(`  version ${version.id}`)
  }

  const localizedVersions = runAgs([
    'legal', 'localized-versions', 'list',
    '--namespace', namespace,
    '--policy-version-id', version.id,
  ])
  let localized = optionalObject(
    localizedVersions,
    item => item.localeCode === manifest.localeCode && typeof item.id === 'string',
  )
  if (!localized) {
    const created = runAgs([
      'legal', 'localized-versions', 'create',
      '--namespace', namespace,
      '--policy-version-id', version.id,
      ...jsonBody({
        contentType,
        description: document.description,
        localeCode: manifest.localeCode,
      }),
    ], { mutate: true })
    if (!apply) return
    localized = findObject(created, item => typeof item.id === 'string', 'created localized version')
    console.log(`  created localized version ${localized.id}`)
  } else {
    console.log(`  localized version ${localized.id}`)
  }

  const localizedDetail = runAgs([
    'legal', 'localized-versions', 'get',
    '--localized-policy-version-id', localized.id,
    '--namespace', namespace,
  ])
  const detail = optionalObject(
    localizedDetail,
    item => item.id === localized.id,
  ) || localized
  const checksumMatches = detail.attachmentChecksum === expectedMD5
  if (!detail.attachmentLocation) {
    await uploadAttachment(localized.id, source, contentType, namespace)
    console.log('  uploaded attachment')
  } else if (!checksumMatches && detail.attachmentChecksum) {
    throw new Error(
      `${document.policyName} ${manifest.displayVersion} already exists with different content. ` +
      'Bump displayVersion before publishing changed legal text.',
    )
  } else {
    console.log('  attachment present')
  }

  // Order matters: commit the version FIRST, then mark the default locale, then
  // publish. set-default 500s intermittently before commit; publish requires a
  // default localized version (error 40046).
  if (!version.isCommitted) {
    runAgs([
      'legal', 'versions', 'update',
      '--namespace', namespace,
      '--policy-version-id', version.id,
      ...jsonBody({
        description: document.description,
        displayVersion: manifest.displayVersion,
        isCommitted: true,
      }),
    ], { mutate: true })
    console.log('  committed version')
  }

  if (!version.isInEffect) {
    // set-default is flaky (occasional 500); retry until publish's precondition
    // is met. It is idempotent, so re-running is safe.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      runAgs([
        'legal', 'localized-versions', 'set-default',
        '--localized-policy-version-id', localized.id,
        '--namespace', namespace,
      ], { mutate: true, allowFailure: true })
      const published = runAgs([
        'legal', 'versions', 'publish',
        '--namespace', namespace,
        '--policy-version-id', version.id,
        '--should-notify', 'true',
      ], { mutate: true, allowFailure: true })
      if (published !== null || !apply) {
        console.log('  set default locale + published version')
        break
      }
      if (attempt === 5) throw new Error(`Failed to publish ${document.policyName} after ${attempt} attempts.`)
      await new Promise(r => setTimeout(r, 1500))
    }
  } else {
    console.log('  version already published')
  }
}

const env = readEnv(await readFile(resolve(root, '.env.production'), 'utf8'))
const namespace = env.VITE_ACCELBYTE_NAMESPACE
const clientId = env.VITE_ACCELBYTE_CLIENT_ID
if (!namespace || !clientId) {
  throw new Error('VITE_ACCELBYTE_NAMESPACE and VITE_ACCELBYTE_CLIENT_ID are required.')
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
console.log(`${apply ? 'Applying' : 'Planning'} AGS Legal ${manifest.displayVersion} in ${namespace}`)
if (!apply) {
  console.log('No changes will be made. Re-run with --apply after reviewing the plan.')
}

const types = runAgs([
  'legal', 'base-policies', 'list-types',
  '--namespace', namespace,
  '--limit', '100',
  '--offset', '0',
])
// The Legal Document policy type (the one that requires an attachment). AGS
// names it "Legal Document"; match on the isNeedDocument flag to be resilient
// to naming, falling back to the display name.
const legalType = findObject(
  types,
  item =>
    typeof item.id === 'string' &&
    (item.isNeedDocument === true || item.policyTypeName === 'Legal Document'),
  'Legal Document policy type',
)

for (const document of manifest.documents) {
  await ensureDocument({
    document,
    manifest,
    legalTypeId: legalType.id,
    namespace,
    clientId,
  })
}

console.log(`\nAGS Legal ${manifest.displayVersion} ${apply ? 'provisioned' : 'plan complete'}.`)
