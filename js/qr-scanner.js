// js/qr-scanner.js
// Reads QR codes from the device camera. Uses the browser's own
// BarcodeDetector where it has one (Chrome on Android), and otherwise the
// bundled jsQR decoder on canvas frames (iPhone Safari, Firefox).
//
//   const scanner = new QrScanner({ video, onText: async (text) => { … } });
//   await scanner.start();   // throws an Error whose message can be shown
//   scanner.stop();          // always releases the camera
//
// onText may return a promise; the next frame is read only after it
// settles, so a slow network call never stacks up duplicate scans.

const JSQR_SRC = '/assets/vendor/jsqr/jsQR.js';

let jsQRLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRLoading) {
    jsQRLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSQR_SRC;
      s.onload = () => {
        if (window.jsQR) return resolve(window.jsQR);
        // Clear the cache before rejecting, or every later attempt hands back
        // this same rejected promise and the camera can never start.
        jsQRLoading = null;
        reject(new Error('QR decoder failed to initialise.'));
      };
      s.onerror = () => {
        jsQRLoading = null;
        reject(new Error('Could not load the QR decoder.'));
      };
      document.head.appendChild(s);
    });
  }
  return jsQRLoading;
}

/** Returns async (video) => string | null using the fastest decoder available. */
async function createDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue || null;
        };
      }
    } catch (err) {
      console.warn('[QrScanner] BarcodeDetector unavailable, using jsQR:', err.message);
    }
  }

  const jsQR = await loadJsQR();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!video.videoWidth) return null;
    // Downscaled frames decode several times faster, and a QR held up to
    // the camera (or shown on a projector) stays well within range at 640px.
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
  };
}

/** A message a person can act on, for a camera that would not start. */
function cameraErrorMessage(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot use the camera here.';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return 'Camera permission was refused. Allow camera access for this site in your browser settings, then try again.';
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (err?.name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return `Could not start the camera (${err?.message || 'unknown error'}).`;
}

export class QrScanner {
  /**
   * @param {{ video: HTMLVideoElement, onText: (text: string) => (void|Promise<void>), intervalMs?: number, repeatMs?: number }} opts
   */
  constructor({ video, onText, intervalMs = 180, repeatMs = 3000 }) {
    this.video = video;
    this.onText = onText;
    this.intervalMs = intervalMs;
    this.repeatMs = repeatMs;
    this.stream = null;
    this.timer = null;
    this.decode = null;
    this.lastText = null;
    this.lastAt = 0;
    // Bumped by stop() and by every start(), so a start() that is still
    // waiting on the camera can tell that it has been superseded or cancelled.
    this.startToken = 0;
  }

  get running() {
    return Boolean(this.stream);
  }

  async start() {
    if (this.stream) return;
    const token = ++this.startToken;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(cameraErrorMessage());

    try {
      this.decode = this.decode || await createDecoder();
    } catch (err) {
      if (token === this.startToken) this.stop();
      throw new Error(cameraErrorMessage(err), { cause: err });
    }
    if (token !== this.startToken) return; // stopped while the decoder loaded

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (err) {
      // Only permission and device failures reach cameraErrorMessage, which
      // exists to explain exactly those.
      if (token === this.startToken) this.stop();
      throw new Error(cameraErrorMessage(err), { cause: err });
    }

    if (token !== this.startToken) {
      // stop() (or a second start()) ran while the permission prompt was up:
      // release the tracks we were just handed instead of leaving the camera on.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.stream = stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (err) {
      // The camera was allowed; the video element itself would not start, so
      // telling the user permission was refused would send them to the wrong
      // browser setting.
      if (token === this.startToken) this.stop();
      throw new Error('Camera access was allowed, but the video would not start. Tap “Start camera” again, or type the ticket code instead.', { cause: err });
    }
    if (token !== this.startToken) return; // stopped while video.play() settled
    this.schedule();
  }

  stop() {
    // Cancels a start() still in flight, so it stops the stream it is about to
    // receive rather than assigning it to a camera that was already closed.
    this.startToken++;
    clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  /** Forget the last code, so showing the same QR again is read again. */
  reset() {
    this.lastText = null;
    this.lastAt = 0;
  }

  schedule() {
    this.timer = setTimeout(() => this.frame(), this.intervalMs);
  }

  async frame() {
    if (!this.stream) return;
    try {
      const text = await this.decode(this.video);
      // stop() can land while the frame is being decoded; a code read from a
      // camera that has since been closed must not reach onText.
      if (!this.stream) return;
      const now = Date.now();
      if (text && !(text === this.lastText && now - this.lastAt < this.repeatMs)) {
        this.lastText = text;
        this.lastAt = now;
        await this.onText(text);
      }
    } catch (err) {
      // A single unreadable frame is normal while the camera refocuses.
      console.debug('[QrScanner] frame skipped:', err?.message);
    }
    if (this.stream) this.schedule();
  }
}
