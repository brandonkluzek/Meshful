# KaTeX runtime

- Version: `0.18.4`
- Source package: `katex@0.18.4` from the npm registry
- Package SHA-256: `0090b1ebccc77d1402ec95e85ee539e1da514d6cd6934156c00baf39dcb0e3aa`
- License: MIT; see `LICENSE`

`katex.js` is the package's `dist/katex.mjs` file renamed so the static server
serves it with the JavaScript MIME type. The stylesheet and fonts are copied
unchanged from `dist/`. They are bundled locally so definition rendering has no
runtime CDN or network dependency.
