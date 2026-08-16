import {
  TRANSLATIONS_BY_ENGLISH,
  TRANSLATIONS_BY_KEY,
} from './locales/catalog.mjs'

export const DEFAULT_LOCALE = 'en'
export const LOCALE_STORAGE_KEY = 'ethans-chess-locale'
export const SUPPORTED_LOCALES = Object.freeze([
  { code: 'en', label: 'English', languageTag: 'en-US', agsLanguage: 'en' },
  { code: 'id', label: 'Bahasa Indonesia', languageTag: 'id-ID', agsLanguage: 'id' },
  { code: 'ms', label: 'Bahasa Melayu', languageTag: 'ms-MY', agsLanguage: 'ms' },
  { code: 'zh-CN', label: '简体中文', languageTag: 'zh-CN', agsLanguage: 'zh-CN' },
])

const localeByCode = new Map(SUPPORTED_LOCALES.map(locale => [locale.code, locale]))
const textSources = new WeakMap()
const attributeSources = new WeakMap()
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title', 'content']
let currentLocale = DEFAULT_LOCALE
let observer = null
let applyingTranslations = false

export function normalizeLocale(value) {
  const candidate = String(value || '').trim().replace(/_/g, '-')
  if (!candidate) return DEFAULT_LOCALE
  const lower = candidate.toLowerCase()
  if (lower === 'id' || lower.startsWith('id-')) return 'id'
  if (lower === 'ms' || lower.startsWith('ms-')) return 'ms'
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-sg' || lower.startsWith('zh-hans')) return 'zh-CN'
  if (lower === 'en' || lower.startsWith('en-')) return 'en'
  return DEFAULT_LOCALE
}

export function resolvePreferredLocale({ storedLocale, navigatorLanguages = [] } = {}) {
  if (storedLocale && localeByCode.has(normalizeLocale(storedLocale))) {
    const normalized = normalizeLocale(storedLocale)
    if (normalized !== DEFAULT_LOCALE || String(storedLocale).toLowerCase().startsWith('en')) return normalized
  }
  for (const language of navigatorLanguages) {
    const normalized = normalizeLocale(language)
    if (normalized !== DEFAULT_LOCALE || String(language).toLowerCase().startsWith('en')) return normalized
  }
  return DEFAULT_LOCALE
}

function readInitialLocale() {
  let storedLocale = ''
  try { storedLocale = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) || '' } catch {}
  const navigatorLanguages = globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : [globalThis.navigator?.language || '']
  return resolvePreferredLocale({ storedLocale, navigatorLanguages })
}

currentLocale = readInitialLocale()

export function getLocale() {
  return currentLocale
}

export function getLanguageTag() {
  return localeByCode.get(currentLocale)?.languageTag || 'en-US'
}

export function getAgsLanguage() {
  return localeByCode.get(currentLocale)?.agsLanguage || 'en'
}

function interpolate(message, values = {}) {
  return String(message).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ))
}

export function t(key, values = {}) {
  const item = TRANSLATIONS_BY_KEY[key]
  if (!item) return interpolate(key, values)
  return interpolate(item[currentLocale] || item.en, values)
}

export function translateEnglish(source, values = {}) {
  const item = TRANSLATIONS_BY_ENGLISH[String(source)]
  if (!item) return interpolate(source, values)
  return interpolate(item[currentLocale] || item.en, values)
}

function splitWhitespace(value) {
  const match = String(value).match(/^(\s*)([\s\S]*?)(\s*)$/)
  return { leading: match?.[1] || '', core: match?.[2] || '', trailing: match?.[3] || '' }
}

function shouldIgnore(element) {
  return !element
    || element.closest?.('[data-i18n-ignore], script, style, noscript, template')
    || element.isContentEditable
}

function translateTextNode(node) {
  const parent = node.parentElement
  if (shouldIgnore(parent)) return
  const { leading, core, trailing } = splitWhitespace(node.nodeValue || '')
  if (!core || !/[A-Za-z]/.test(core)) return

  let record = textSources.get(node)
  if (!record || (record.last !== undefined && core !== record.last)) {
    record = { source: core, last: undefined }
    textSources.set(node, record)
  }
  const translated = translateEnglish(record.source)
  record.last = translated
  if (translated !== core) node.nodeValue = `${leading}${translated}${trailing}`
}

function translateAttributes(element) {
  if (shouldIgnore(element)) return
  let records = attributeSources.get(element)
  if (!records) {
    records = new Map()
    attributeSources.set(element, records)
  }

  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    if (!element.hasAttribute?.(attribute)) continue
    const current = element.getAttribute(attribute) || ''
    let record = records.get(attribute)
    if (!record || (record.last !== undefined && current !== record.last)) {
      record = { source: current, last: undefined }
      records.set(attribute, record)
    }
    const translated = translateEnglish(record.source)
    record.last = translated
    if (translated !== current) element.setAttribute(attribute, translated)
  }
}

function translateExplicitElement(element) {
  if (!element.matches?.('[data-i18n]')) return
  const key = element.dataset.i18n
  if (!key) return
  const translated = t(key)
  if (element.textContent !== translated) element.textContent = translated
}

function applyToRoot(root) {
  if (!root) return
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return

  const element = root.nodeType === Node.ELEMENT_NODE ? root : null
  if (element) {
    if (shouldIgnore(element)) return
    translateExplicitElement(element)
    translateAttributes(element)
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node)
    else {
      translateExplicitElement(node)
      translateAttributes(node)
    }
    node = walker.nextNode()
  }
}

export function applyTranslations(root = globalThis.document) {
  if (!root || typeof Node === 'undefined') return
  applyingTranslations = true
  applyToRoot(root)
  queueMicrotask(() => { applyingTranslations = false })
}

function syncDocumentLocale() {
  if (!globalThis.document) return
  document.documentElement.lang = getLanguageTag()
  const select = document.getElementById('app-language-select')
  if (select && select.value !== currentLocale) select.value = currentLocale
}

export function setLocale(locale, { persist = true, announce = true } = {}) {
  const normalized = normalizeLocale(locale)
  const changed = normalized !== currentLocale
  currentLocale = normalized
  if (persist) {
    try { globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, normalized) } catch {}
  }
  syncDocumentLocale()
  applyTranslations()
  if (changed && announce && globalThis.window) {
    window.dispatchEvent(new CustomEvent('ethans-chess:locale-changed', {
      detail: {
        locale: currentLocale,
        languageTag: getLanguageTag(),
        agsLanguage: getAgsLanguage(),
      },
    }))
  }
  return currentLocale
}

export function initI18n() {
  if (!globalThis.document) return
  syncDocumentLocale()
  applyTranslations()

  const select = document.getElementById('app-language-select')
  select?.addEventListener('change', event => setLocale(event.currentTarget.value))

  observer?.disconnect()
  observer = new MutationObserver(mutations => {
    if (applyingTranslations) return
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') applyTranslations(mutation.target)
      else if (mutation.type === 'attributes') applyTranslations(mutation.target)
      else for (const node of mutation.addedNodes) applyTranslations(node)
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  })

  window.agsT = t
  window.agsI18n = Object.freeze({
    getAgsLanguage,
    getLanguageTag,
    getLocale,
    setLocale,
    t,
    translateEnglish,
  })
}
