# Known issues

The stable Local REST failures previously recorded here no longer affect the default backend because the standalone implementation reads and writes the vault directly through the filesystem.

## Release safety gates

See [RELEASING.md](./RELEASING.md) for remaining deployment and release gates. K03 (search read scopes), K04 (search freshness), issue #4 (YAML precision) and #16 (bounded regex) have regression coverage on current main. This branch adds K06 Local REST enforcement (#17), protected paths, private cache, HTTP and runtime gates. Deployment runtime inventories and Windows cache ACL verification remain operator responsibilities.

## Compatibility backend

The deprecated `local-rest` backend still inherits behavior and response-shape differences from the installed Obsidian Local REST API plugin. In particular, metadata, heading patching, advanced search, empty-folder creation, and folder moves may vary by plugin version.

Use the default `filesystem` backend for standalone behavior. This remains an alpha; it is not a production-safety guarantee. Compatibility-backend defects should be fixed only when they block migration and must not add new core dependencies on the REST API.

## Reporting a filesystem issue

Include the operating system, Node.js version, relevant configuration without secrets, tool name, structured error code, and a minimal fixture vault. Do not attach private note content unless it is necessary and redacted.
