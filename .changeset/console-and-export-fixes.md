---
'@otwdesign/db-ui': patch
'@otwdesign/plugin-db': patch
---

Two fixes in the app:

- Opening the Console no longer crashes the app. In today's Chrome `scrollIntoView()` returns a promise, and the console's effect handed it to React as its cleanup.
- Export works where the app sits in a shadow root: the CMS's Database screen, and any page with `<otw-db-app>`. A click on a format was taken for a click outside the menu, which closed first.
