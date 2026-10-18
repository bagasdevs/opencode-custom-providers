# Catalog submission patch

`opencode-custom-providers.yaml` is the entry for
[Heretek-AI/awesome-opencode#469](https://github.com/Heretek-AI/awesome-opencode/pull/469),
which is on hold with `needs-metadata`.

The file in the PR has only `name`, `repo`, `tagline` and `description`. The catalog requires
`kind` and `topics`, and a plugin must declare `compat`. Running the catalog's own
`checkCatalog` against the PR content reports:

```
must have required property 'kind'
must have required property 'topics'
plugins must declare compat (v2, v1 or unknown); CI verifies it
```

The version here adds those fields plus `npm`, so the V2 probe reads package metadata instead
of falling back to a source scan. It validates clean against `scripts/utils/catalog.js` from
awesome-opencode.

To apply: replace the contents of `data/plugins/opencode-custom-providers.yaml` in the PR with
this file.
