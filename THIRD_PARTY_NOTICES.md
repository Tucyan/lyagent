# Third-party notices

Course Agent bundles the following redistributable runtimes and open-source
components. This notice is informational and does not replace the license files
shipped inside each runtime or Python package metadata directory.

| Component | Version | License | Project |
|---|---:|---|---|
| Node.js | 24.11.1 | MIT and bundled third-party notices | <https://nodejs.org/> |
| Python | 3.12.10 | Python Software Foundation License | <https://www.python.org/> |
| Docling | 2.118.0 | MIT | <https://github.com/docling-project/docling> |
| Docling Serve | 1.28.0 | MIT | <https://github.com/docling-project/docling-serve> |

The complete exact-pinned Python dependency inventory is shipped as
`requirements-release-win-x64.txt`. Package-specific licenses and notices are
also retained under `runtime/python/Lib/site-packages/*.dist-info/`.

Docling model artifacts may have model-specific licenses. The Full package
retains the metadata downloaded by the pinned `docling-tools` command. Users
who replace or add models are responsible for the corresponding model terms.
