// Extension-origin document: a Worker built here isn't bound by youtube.com's
// CSP, unlike one constructed from the content script.
const worker = new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });

worker.onmessage = (e) => {
  const { type, videoId, chunkRange, segments } = e.data;
  if (type !== 'chunkResult') return;
  chrome.runtime.sendMessage({ type: 'transcribeResult', videoId, chunkRange, segments });
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'runTranscribe') return;
  worker.postMessage(
    { type: 'transcribeChunk', videoId: msg.videoId, chunkRange: msg.chunkRange, pcm: msg.pcm, sampleRate: msg.sampleRate },
    [msg.pcm.buffer]
  );
});
