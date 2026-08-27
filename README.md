# Instagram archive

A browser app for exploring an Instagram data export. It reports one-to-one message activity by person, hour, weekday, and date; separates the two sides of a conversation; counts reactions; and groups follower relationships.

The application is static. It opens the ZIP files in the browser, reads the supported JSON entries, and ignores photos, videos, and other media. There is no upload endpoint. Reloading the page clears the archive.

## Preparing the export

Use Instagram's Export your information tool in Accounts Center and choose an export to your device. Keep the downloaded files as ZIPs. These settings produce the most useful report:

- Format: JSON. HTML exports are not supported.
- Date range: all time. A shorter range produces a correspondingly incomplete report.
- Information: Messages, Personal information, and Followers and following.
- Media quality: any setting. The application does not read media files.

A partial export also works. Message reports require Messages and Personal information; follow reports require both the followers and following files. If Instagram divides an export into several ZIPs, select all of them in the same file picker.

## Reports

The message overview shows the 25 largest one-to-one conversations, activity by local hour and weekday, and the 25 most-used reactions. Selecting a conversation adds the message split between you and the other person, daily or monthly volume, a cumulative message count, and reactions grouped by who used them.

The follow report divides accounts into mutual follows, accounts you follow without a follow-back, and accounts that follow you without being followed back. It also shows the timestamp recorded for each relationship.

## Implementation

The data path is:

```text
ZIP files
-> supported JSON entries
-> normalized messages and follows
-> aggregate reports
-> Lit views
-> Chart.js
```

[`InstagramArchive.open`](src/archive.ts) accepts one or more ZIP `Blob`s. zip.js enumerates each archive, path normalization removes the export's outer directory, and only the message, personal-information, follower, and following files are extracted. Files from split archives are merged by logical path. Identical duplicates are accepted, while conflicting copies are rejected.

Message parsing reduces each raw record to its author, timestamp, and reactions. [`analyzeConversations`](src/analysis.ts) builds the overall and per-conversation reports in one pass. The returned model contains source filenames, aggregates, conversation names, reactions, and follow records. A decoder also repairs the UTF-8 text that some Instagram exports store as mojibake.

The interface in [`src/app.ts`](src/app.ts) has four states: empty, loading, error, and ready. A ready page is an overview, one conversation, or the follow report, and the render switch selects the matching view. The `ArchiveChart` component in [`src/charts.ts`](src/charts.ts) converts a small chart specification into Chart.js configuration and destroys the old chart when its specification changes or the component disconnects.

## Development

Requires Node.js 26 or newer.

```sh
npm ci
npm run dev
```

Run the archive tests and production build with:

```sh
npm test
npm run build
```

The tests create ZIP archives in memory and cover complete, split, partial, conflicting, and incomplete exports. The GitHub Pages workflow runs the tests and build before deploying `dist` on pushes to `main`.

## Limitations

- Only one-to-one message threads are analyzed. Threads with zero or more than one other participant are ignored.
- Message bodies and media are not retained, so the reports cannot analyze words, links, attachments, or calls.
- Message hours and weekdays use the browser's local timezone.
- The people and reaction charts show at most 25 entries.
- The parser targets Instagram's current JSON paths and fields. A future export schema change may require parser changes.
