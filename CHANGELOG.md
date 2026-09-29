# Changelog

All notable changes to this project will be documented in this file.

<!-- git-cliff-unreleased-start -->
## 0.1.1 - **not yet released**


<!-- git-cliff-unreleased-end -->
## [0.1.0](https://github.com/apify/actor-runtime/releases/tag/v0.1.0) (2026-09-29)

### 🚀 Features

- Add first-draft local actor-runtime prototype ([#1](https://github.com/apify/actor-runtime/pull/1)) ([2fa0b71](https://github.com/apify/actor-runtime/commit/2fa0b719d2ddd02be1930567fe2604d56604eee6)) by [@Pijukatel](https://github.com/Pijukatel)
- Add multi-user support with placeholder login and improved console ([#2](https://github.com/apify/actor-runtime/pull/2)) ([3a36f47](https://github.com/apify/actor-runtime/commit/3a36f475feb336e7c0430446f113a43d42d10423)) by [@Pijukatel](https://github.com/Pijukatel)
- Add standby-actor support and platform-parity env vars ([#3](https://github.com/apify/actor-runtime/pull/3)) ([813c3bf](https://github.com/apify/actor-runtime/commit/813c3bf6df108c543514107b0ac733f5169c4ac2)) by [@Pijukatel](https://github.com/Pijukatel)
- Use the Apify SDK for all storage access in the sample actors ([#5](https://github.com/apify/actor-runtime/pull/5)) ([c330dcf](https://github.com/apify/actor-runtime/commit/c330dcfc8ea2eeb18ca08e22c22f5795419d5495)) by [@Pijukatel](https://github.com/Pijukatel)
- Add proxy-enabled ParselCrawler sample Actor and APIFY_PROXY_PASSWORD passthrough ([#8](https://github.com/apify/actor-runtime/pull/8)) ([dcf54af](https://github.com/apify/actor-runtime/commit/dcf54aff26bd48cc05bbd04be5373bb0c64d2277)) by [@Pijukatel](https://github.com/Pijukatel)
- Emulate platform migrations and reboot ([#31](https://github.com/apify/actor-runtime/pull/31)) ([6e6431b](https://github.com/apify/actor-runtime/commit/6e6431b77b764e857efcaf25d5c35fc06d974971)) by [@Pijukatel](https://github.com/Pijukatel)
- Add browser view (passive and interactive modes)  ([#41](https://github.com/apify/actor-runtime/pull/41)) ([9c64d5a](https://github.com/apify/actor-runtime/commit/9c64d5ab47b0ea5b3ecabad0e4f71f781c705e48)) by [@Pijukatel](https://github.com/Pijukatel)
- Improved runtime compatibility ([#42](https://github.com/apify/actor-runtime/pull/42)) ([d2f88ce](https://github.com/apify/actor-runtime/commit/d2f88ce4a2f3e0a4c4fc4a682674f6afff63ea0b)) by [@Pijukatel](https://github.com/Pijukatel)
- Make the dev folder default behavior ([#43](https://github.com/apify/actor-runtime/pull/43)) ([cdcb714](https://github.com/apify/actor-runtime/commit/cdcb714cef3fe68ca3b969c1517771f8234dc4c7)) by [@Pijukatel](https://github.com/Pijukatel)
- Mark runtime-authored log lines with a prefix and blue color ([#49](https://github.com/apify/actor-runtime/pull/49)) ([cee0fb3](https://github.com/apify/actor-runtime/commit/cee0fb3736896e904fa30bd4ee01c00d0adc5759)) by [@Pijukatel](https://github.com/Pijukatel), closes [#44](https://github.com/apify/actor-runtime/issues/44)
- Style the console with Apify&#x27;s design ([#66](https://github.com/apify/actor-runtime/pull/66)) ([6c576db](https://github.com/apify/actor-runtime/commit/6c576db70d2977c158fcb67e10fd07b4fb893de9)) by [@Pijukatel](https://github.com/Pijukatel), closes [#61](https://github.com/apify/actor-runtime/issues/61)
- Add storage&#x2F;Actor addressing by username~name, userId~name, ~name ([#67](https://github.com/apify/actor-runtime/pull/67)) ([3560ed8](https://github.com/apify/actor-runtime/commit/3560ed8e3832f7c769b9dafd2249aa29b778fe2d)) by [@Pijukatel](https://github.com/Pijukatel)
- Implement the runs&#x2F;last shortcuts ([#68](https://github.com/apify/actor-runtime/pull/68)) ([d9cd69e](https://github.com/apify/actor-runtime/commit/d9cd69e066936cfa2a8c4f5e289dbd6a4ae84ffc)) by [@Pijukatel](https://github.com/Pijukatel)
- Support pay-per-event pricing and estimate run cost ([#69](https://github.com/apify/actor-runtime/pull/69)) ([cdd79bd](https://github.com/apify/actor-runtime/commit/cdd79bd26fc518d7addeaf7b792d90956cc68348)) by [@Pijukatel](https://github.com/Pijukatel), closes [#59](https://github.com/apify/actor-runtime/issues/59)
- Validate Actor input and apply input-schema defaults ([#72](https://github.com/apify/actor-runtime/pull/72)) ([d0937e0](https://github.com/apify/actor-runtime/commit/d0937e0ed4757f05113b1b3362a7c42108ea3c5b)) by [@Pijukatel](https://github.com/Pijukatel)
- Size runs by the memory fields of .actor&#x2F;actor.json ([#74](https://github.com/apify/actor-runtime/pull/74)) ([fa27181](https://github.com/apify/actor-runtime/commit/fa2718143255126b516a4cb15d7a8590a934ed3f)) by [@Pijukatel](https://github.com/Pijukatel)
- Emulate single-tenant Actor Standby ([#76](https://github.com/apify/actor-runtime/pull/76)) ([206fed1](https://github.com/apify/actor-runtime/commit/206fed17b534e0f4095e3c4d7421cbec1b68d463)) by [@Pijukatel](https://github.com/Pijukatel), closes [#60](https://github.com/apify/actor-runtime/issues/60)
- Make the API and console ports configurable ([#80](https://github.com/apify/actor-runtime/pull/80)) ([16abee7](https://github.com/apify/actor-runtime/commit/16abee705c4712cbfa249a1c91b30b2bfd5ab299)) by [@Pijukatel](https://github.com/Pijukatel), closes [#77](https://github.com/apify/actor-runtime/issues/77)

### 🐛 Bug Fixes

- Fix debugpy adapter not working for non root user Actors ([#48](https://github.com/apify/actor-runtime/pull/48)) ([a21fd26](https://github.com/apify/actor-runtime/commit/a21fd2658ea6cfeb0131fbcf9d7d42b66e1be8fa)) by [@Pijukatel](https://github.com/Pijukatel)
- Build amd64-only Actor images on arm64 hosts ([#55](https://github.com/apify/actor-runtime/pull/55)) ([2ec5f7f](https://github.com/apify/actor-runtime/commit/2ec5f7fe7791a927315f909a0e03bcd619022f8d)) by [@Pijukatel](https://github.com/Pijukatel)
- Make Abort responsive ([#64](https://github.com/apify/actor-runtime/pull/64)) ([c495314](https://github.com/apify/actor-runtime/commit/c495314cced81b393a4566f19b7860e5de239ed1)) by [@Pijukatel](https://github.com/Pijukatel)


