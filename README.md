# Instagram archive

A browser app for exploring your own Instagram data export: message activity
by person, hour, and weekday; reactions; follower reciprocity; and follow
dates.

Everything runs in your browser. The app reads only supported JSON entries
directly from the ZIP and ignores its media. Nothing is uploaded.

## Get your data

Instagram is moving accounts to Meta Accounts, so you may see either "Accounts
Center" or "Meta Account settings" when managing your account. The export lives
in the same place either way.

To export to your device:

1. Open Instagram, click More (the hamburger menu) in the bottom left, then
   Settings.
2. Click Accounts Center, then Your information and permissions.
3. Click Export your information, then Create export.
4. Select the profile to export, then click Next.
5. Select Export to device.
6. Customize the export (see below), then click Start export.

Instagram emails you when the export is ready. It arrives as one or more `.zip`
files. Keep them zipped.

### Export settings that matter

The customization step lets you choose which information to include, a date
range, a format, the notification email, and media quality. Four of these
affect whether this app can read the export.

For information, select all of your information, or at minimum the three
categories the app reads: Messages, Personal information, and Followers and
following. For format, choose JSON; the app cannot read the HTML export. For
date range, choose all time, so activity and follower history are complete.
Media quality does not matter, since the app reads only the JSON data and never
the photos or videos, so the lowest setting keeps the download small.

## Develop

Install [Node.js](https://nodejs.org/) 24 or newer, then run:

```sh
npm install
npm run dev
```

Choose your export `.zip` in the browser. If Instagram split the export into
several ZIP files, choose all of them together.

Run the tests and production build with:

```sh
npm test
npm run build
```
