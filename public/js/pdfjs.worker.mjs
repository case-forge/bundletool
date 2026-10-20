// Starts the shared pdf.js worker from inside BundleTool's own folder, so the offline service worker (scope
// /bundletool/) controls it and it starts with the network off. The library file itself is shared: /vendor/.
import '/vendor/pdfjs.worker.mjs';
