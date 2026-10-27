# Verbatim

Live transcription for meetings and lectures on iPhone. It runs as a web app in Safari, with no App Store and no build step.

- **Live transcript** from Apple's speech recognition (the same engine as iPhone dictation). It restarts automatically when Safari stops listening, and notes any gaps.
- **Timestamps and speakers.** Tap a speaker chip when someone else starts talking, and rename speakers at any time. Tap **Mark** to highlight an important moment.
- **History.** Every recording is saved on the device (IndexedDB). You can search, rename, edit lines and record more later.
- **Export** to Word (.docx), plain text, Markdown or a JSON backup, through the iOS share sheet (Save to Files, AirDrop, Mail, Notes) or as a download.
- **Summary and action items** from Claude: meeting notes (decisions, owners, due dates) or study notes (key terms, assignments, review questions). Use your own Anthropic API key, or copy a ready-made prompt into the Claude app and paste the answer back.

## Hosting

Safari only allows the microphone on HTTPS pages, so serve this folder from any static host, such as GitHub Pages, Netlify or Cloudflare Pages. There is no build step; the files are served as they are.

To try it locally on a computer:

```sh
python3 -m http.server 8000   # then open http://localhost:8000 in Chrome or Safari
```

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | App shell and styles |
| `app.js` | UI, recording controller, sheets |
| `engine.js` | Speech recognizer wrapper (auto-restart, iOS duplicate-result fix) |
| `store.js` | IndexedDB storage |
| `export.js` | Word, text, Markdown and JSON exports (includes a small .docx/zip writer) |
| `summary.js` | Claude summaries (`claude-opus-5-5`, streaming, server-side fallback) |
| `markdown.js`, `util.js` | Helpers |
| `vendor/anthropic-sdk.mjs` | `@anthropic-ai/sdk` 0.133.0 bundled as one ES module |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline launch and Home Screen install |

## Privacy

Audio goes to Apple's speech service, the same way it does when you dictate on iPhone. Transcripts stay on the device. When you ask for a summary, the transcript goes from the phone straight to Anthropic, using your API key, which is stored only on the device.
