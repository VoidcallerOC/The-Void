# Private media storage

This directory is a server-only storage mount for **local/dev filesystem** protected media. Full-resolution masters, video, stems, demos, live recordings, and downloads must never be copied into the Vite `public/` tree and must never be committed to Git.

## Storage boundary

| Environment | Where full masters live | Public tree |
| --- | --- | --- |
| Production | Pinata private IPFS (`MEDIA_STORAGE_DRIVER=pinata`) | `public/assets/audio-preview/*-preview.*` only |
| Local/dev | This ignored mount (`MEDIA_STORAGE_DRIVER=filesystem`, `MEDIA_PRIVATE_ROOT` / `PRIVATE_MEDIA_ROOT`) | Same preview-only rule |

`public/assets/audio/` is forbidden. CI rejects that directory and any non-`*-preview` audio under `public/assets/audio-preview/`.

Expected protected audio keys use the form `audio/<filename>`, matching the server media catalog. Populate production masters through the controlled Pinata private-upload path (Studio / server adapters), not by committing bytes.
