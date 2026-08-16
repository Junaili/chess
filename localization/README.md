# Localization workflow

The source of truth is `src/locales/catalog.mjs`. Every row keeps a stable key,
English source, Indonesian (`id`), Malay (`ms`), and Simplified Chinese
(`zh-CN`) side by side. The initial non-English copy is marked `draft` until a
professional translator validates it.

Run `npm run i18n:export` to regenerate `translation-review.csv`. Send that CSV
to translators, then copy approved wording back into the catalog and change the
row status to `reviewed`. Do not edit the generated CSV directly.

New static copy should use a stable catalog key. Runtime copy should call
`t(key, values)`. The DOM translator also recognizes cataloged English text as a
migration bridge for the existing interface. User-generated content can opt out
with `data-i18n-ignore`.

AGS locale mapping:

- IAM password-reset messages use the selected BCP 47 language tag.
- Achievement and Platform catalog requests use the selected AGS language.
- AGS Legal chooses the closest localized policy version, then the configured
  default, then the first published version.

English remains the fallback when a translation or localized AGS resource is
not available.
