# The iPhone app

A Capacitor wrapper around the same files the website serves (`public/`,
built by `npm run build`). Nothing here needs changing for a web update:
rebuild and sync, then run it from Xcode.

## Build and run

1. On a Mac with Xcode 16 or newer: `npm install`
2. `npm run cap:sync` (builds `public/` and copies it into the app)
3. `npm run cap:open`, pick a team under Signing & Capabilities, and run

## To the App Store

1. In Xcode, set the version (Marketing Version) and build number
2. Product > Archive, then Distribute App > App Store Connect
3. In App Store Connect: the listing, screenshots (6.9" and 6.5"), the
   privacy answers (email for log in; imports kept in your own Supabase
   storage), then submit for review

## What's set

- App icon: `App/App/Assets.xcassets/AppIcon.appiconset` (1024, from
  `images/app-icon.png`)
- Launch screen: the page's own colour, light or dark
  (`Splash.imageset`), so opening it never flashes white
- The service worker stays off in the app (the files are inside it), and
  the page is marked `is-capacitor` for the notch and home bar
