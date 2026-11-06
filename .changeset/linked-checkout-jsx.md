---
'@otwdesign/plugin-db': patch
---

The Database screen no longer adds `<otw-db-app>` to the site's JSX types. A site that links the plugin from a checkout, with its own copy of React's types, now type-checks.
