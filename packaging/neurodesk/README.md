# Neurodesk recipe

`neurovue/` is the recipe for [NeuroDesk/neurocontainers](https://github.com/NeuroDesk/neurocontainers)
(`recipes/neurovue/`). It installs the `neurovue-web` release tarball and
registers NeuroVue as a Neurodesk web app (`deploy.webapp`), which the
Neurodesk launcher starts with `neurovue start` on `$NEURODESK_WEBAPP_PORT`.

To release a new version:

1. `scripts/package-web.sh` builds `dist-pkg/neurovue-web-<version>-linux-x86_64.tar.gz`
   and its `.sha256`.
2. Attach the tarball to the GitHub release `v<version>`.
3. In the recipe, set `version` (in both `build.yaml` and `fulltest.yaml`) and
   the tarball `sha256`, then open a PR to neurocontainers with `recipes/neurovue/`.

Test locally from a neurocontainers checkout with `sf-test neurovue --build`.
