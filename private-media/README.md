# Private media storage

This directory is a server-only storage mount. Protected full-resolution audio, video, stems, demos, live recordings, and downloads must be uploaded here (or to a provider-backed adapter) during deployment. The contents are intentionally ignored by Git and are never copied into the Vite `public/` tree.

Expected protected audio keys use the form `audio/<filename>`, matching the server media catalog. Configure `PRIVATE_MEDIA_ROOT` to the mounted directory in production. Public previews remain under `public/assets/audio-preview/`.
