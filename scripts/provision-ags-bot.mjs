// Verifies (and optionally creates) the AGS player account a chess bot
// personality plays as, then prints the config lines to wire it up.
//
// Every personality signs in as its OWN account: that is what lets two bot
// games run at once, keeps one bot's games out of another's match history, and
// lets the match watcher tell a bot's queue ticket from a human's.
//
// Usage (dry-run by default, --apply to create a missing account):
//   AB_CLIENT_ID=... AB_CLIENT_SECRET=... \
//     node scripts/provision-ags-bot.mjs --bot fortress-fiona \
//       --email chlydeklie@gmail.com --display-name "Fortress Fiona" [--apply]
//
// Credentials come from the environment and are NEVER written to the repo:
// pass --password only with --apply, and put the result in the DS's
// .env.ams / the Extend app's secrets, not in git.

const NAMESPACE = process.env.AGS_NAMESPACE || 'seal-chessags'
const BASE = process.env.AGS_BASE_URL || `https://${NAMESPACE}.prod.gamingservices.accelbyte.io`
const CLIENT_ID = process.env.AB_CLIENT_ID
const CLIENT_SECRET = process.env.AB_CLIENT_SECRET

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const botID = arg('bot')
const email = arg('email')
const displayName = arg('display-name')
const password = arg('password') || process.env.BOT_PASSWORD || ''
const apply = process.argv.includes('--apply')

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('AB_CLIENT_ID and AB_CLIENT_SECRET are required (they live in ~/.zshenv).')
  process.exit(2)
}
if (!botID || !email) {
  console.error('Usage: node scripts/provision-ags-bot.mjs --bot <id> --email <address> [--display-name <name>] [--apply]')
  process.exit(2)
}

async function token() {
  const resp = await fetch(`${BASE}/iam/v3/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  const data = await resp.json()
  if (!resp.ok || !data.access_token) {
    throw new Error(`token -> ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data.access_token
}

async function findByEmail(accessToken) {
  const resp = await fetch(
    `${BASE}/iam/v3/admin/namespaces/${NAMESPACE}/users?emailAddress=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (resp.status === 404) return null
  const data = await resp.json()
  if (!resp.ok) throw new Error(`lookup -> ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`)
  // The IAM email lookup has returned both a list and a bare object across
  // versions (it changed shape once already and broke invite auto-friend), so
  // accept either rather than trusting one.
  const user = Array.isArray(data?.data) ? data.data[0] : (data?.userId ? data : null)
  return user || null
}

async function create(accessToken) {
  if (!password) throw new Error('--password (or BOT_PASSWORD) is required to create an account')
  const resp = await fetch(`${BASE}/iam/v4/admin/namespaces/${NAMESPACE}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authType: 'EMAILPASSWD',
      emailAddress: email,
      password,
      displayName: displayName || botID,
      uniqueDisplayName: displayName || botID,
      country: 'US',
    }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(`create -> ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`)
  return data
}

const accessToken = await token()
let user = await findByEmail(accessToken)

if (user) {
  console.log(`✓ ${botID}: account already exists`)
  console.log(`    userId      ${user.userId}`)
  console.log(`    displayName ${user.displayName || '(unset)'}`)
  console.log(`    enabled     ${user.enabled}`)
  if (displayName && user.displayName !== displayName) {
    console.log(`  ! displayName is ${JSON.stringify(user.displayName)}, expected ${JSON.stringify(displayName)}`)
  }
} else if (!apply) {
  console.log(`• ${botID}: no account for ${email} — re-run with --apply --password <pw> to create it`)
  process.exit(0)
} else {
  user = await create(accessToken)
  console.log(`✓ ${botID}: created account ${user.userId}`)
}

console.log('\nWire it up (secrets go in Extend/AMS config, never in git):')
console.log(`  Extend app var  BOT_ACCOUNTS  … add "${botID}":"${user.userId}"`)
const envSuffix = botID.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
console.log(`  DS .env.ams     BOT_EMAIL_${envSuffix}=${email}`)
console.log(`                  BOT_PASSWORD_${envSuffix}=<the account password>`)
