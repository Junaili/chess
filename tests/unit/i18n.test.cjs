const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const i18nPromise = import(pathToFileURL(path.resolve(__dirname, '../../src/i18n.mjs')))
const catalogPromise = import(pathToFileURL(path.resolve(__dirname, '../../src/locales/catalog.mjs')))

test('normalizes supported browser language tags and falls back to English', async () => {
  const { normalizeLocale } = await i18nPromise
  assert.equal(normalizeLocale('id-ID'), 'id')
  assert.equal(normalizeLocale('ms-MY'), 'ms')
  assert.equal(normalizeLocale('zh-Hans-SG'), 'zh-CN')
  assert.equal(normalizeLocale('fr-FR'), 'en')
})

test('stored preference wins and unsupported preferences defer to browser languages', async () => {
  const { resolvePreferredLocale } = await i18nPromise
  assert.equal(resolvePreferredLocale({ storedLocale: 'ms', navigatorLanguages: ['id-ID'] }), 'ms')
  assert.equal(resolvePreferredLocale({ storedLocale: 'fr', navigatorLanguages: ['id-ID'] }), 'id')
  assert.equal(resolvePreferredLocale({ navigatorLanguages: ['fr-FR', 'zh-Hans'] }), 'zh-CN')
})

// Must run before any test below loads the catalog — the module caches it
// once loaded for the process lifetime, so "not yet loaded" is only
// observable this early.
test('the catalog is not loaded for the English locale, and t() defers to the DOM until it is', async () => {
  const { ensureCatalogLoaded, setLocale, t } = await i18nPromise
  setLocale('en', { persist: false, announce: false })
  assert.equal(await ensureCatalogLoaded(), null)

  setLocale('ms', { persist: false, announce: false })
  assert.equal(t('common.save'), undefined)
  await ensureCatalogLoaded()
  assert.equal(t('common.save'), 'Simpan')
  setLocale('en', { persist: false, announce: false })
})

test('translation lookup and AGS locale mappings follow the active locale', async () => {
  const { ensureCatalogLoaded, getAgsLanguage, getLanguageTag, setLocale, t, translateEnglish } = await i18nPromise
  setLocale('zh-Hans', { persist: false, announce: false })
  await ensureCatalogLoaded()
  assert.equal(t('common.save'), '保存')
  assert.equal(translateEnglish('Cancel'), '取消')
  assert.equal(getLanguageTag(), 'zh-CN')
  assert.equal(getAgsLanguage(), 'zh-CN')

  setLocale('id-ID', { persist: false, announce: false })
  await ensureCatalogLoaded()
  assert.equal(t('common.save'), 'Simpan')
  assert.equal(getLanguageTag(), 'id-ID')
  assert.equal(getAgsLanguage(), 'id')
  setLocale('en', { persist: false, announce: false })
})

test('catalog has unique stable keys and complete draft translations', async () => {
  const { TRANSLATION_CATALOG } = await catalogPromise
  const keys = new Set()
  for (const item of TRANSLATION_CATALOG) {
    assert.ok(item.key)
    assert.ok(item.en)
    assert.ok(item.id)
    assert.ok(item.ms)
    assert.ok(item['zh-CN'])
    assert.equal(item.status, 'draft')
    assert.equal(keys.has(item.key), false, `duplicate key: ${item.key}`)
    keys.add(item.key)
  }
  assert.ok(TRANSLATION_CATALOG.length >= 200)
})
