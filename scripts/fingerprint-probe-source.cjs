const COMMON_WINDOWS_FONTS = [
  "Arial",
  "Arial Black",
  "Bahnschrift",
  "Calibri",
  "Cambria",
  "Candara",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Corbel",
  "Courier New",
  "Franklin Gothic Medium",
  "Gabriola",
  "Georgia",
  "Impact",
  "Lucida Console",
  "Lucida Sans Unicode",
  "Microsoft Sans Serif",
  "Palatino Linotype",
  "Segoe Print",
  "Segoe Script",
  "Segoe UI",
  "Segoe UI Emoji",
  "Segoe UI Symbol",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Webdings",
  "Wingdings",
];

function runtimeSource() {
  return `
const COMMON_WINDOWS_FONTS = ${JSON.stringify(COMMON_WINDOWS_FONTS)};

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hashValue(value) {
  return hashBytes(new TextEncoder().encode(stableStringify(value)));
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(8)) : value;
}

function canvasFactory(forceOffscreen = false) {
  if (forceOffscreen || typeof document === 'undefined') {
    if (typeof OffscreenCanvas === 'undefined') return null;
    return (width, height) => new OffscreenCanvas(width, height);
  }
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

async function measureCanvas(makeCanvas) {
  if (!makeCanvas) return { supported: false };
  const canvas = makeCanvas(320, 120);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { supported: false };
  context.fillStyle = '#f2c94c';
  context.fillRect(0, 0, 320, 120);
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = 'rgba(0, 128, 255, 0.73)';
  context.beginPath();
  context.arc(92.5, 61.25, 47.75, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = 'source-over';
  context.font = '18.25px Arial';
  context.fillStyle = '#172a3a';
  context.fillText('MKT fingerprint 0123456789', 13.5, 103.25);
  const metrics = context.measureText('MKT fingerprint 0123456789');
  const pixels = context.getImageData(0, 0, 320, 120).data;
  return {
    supported: true,
    readings: {
      imageHash: await hashBytes(pixels),
      textMetrics: {
        width: round(metrics.width),
        actualBoundingBoxAscent: round(metrics.actualBoundingBoxAscent),
        actualBoundingBoxDescent: round(metrics.actualBoundingBoxDescent),
        actualBoundingBoxLeft: round(metrics.actualBoundingBoxLeft),
        actualBoundingBoxRight: round(metrics.actualBoundingBoxRight),
      },
    },
  };
}

async function measureFonts(makeCanvas) {
  if (!makeCanvas) return { supported: false };
  const context = makeCanvas(600, 80).getContext('2d');
  if (!context) return { supported: false };
  const sample = 'mmmmmmmmmmlliWW@#0123456789';
  context.font = '72px monospace';
  const mono = context.measureText(sample).width;
  context.font = '72px serif';
  const serif = context.measureText(sample).width;
  context.font = '72px sans-serif';
  const sans = context.measureText(sample).width;
  const detected = [];
  const metrics = {};
  const localLoads = {};
  for (const family of COMMON_WINDOWS_FONTS) {
    context.font = '72px "' + family.replaceAll('"', '') + '", monospace';
    const width = round(context.measureText(sample).width);
    metrics[family] = width;
    if (width !== round(mono) && width !== round(serif) && width !== round(sans)) detected.push(family);
    if (typeof FontFace === 'function') {
      try {
        const face = new FontFace('mkt-probe-' + detected.length, 'local("' + family.replaceAll('"', '') + '")');
        await face.load();
        localLoads[family] = face.status;
      } catch {
        localLoads[family] = 'unavailable';
      }
    }
  }
  const fontSet = typeof document !== 'undefined' ? document.fonts : globalThis.fonts;
  const loadedFamilies = fontSet
    ? [...fontSet].map((face) => ({ family: face.family, status: face.status, weight: face.weight })).sort((a, b) => a.family.localeCompare(b.family))
    : [];
  return {
    supported: true,
    readings: {
      detectedCount: detected.length,
      detectedHash: await hashValue(detected),
      metricsHash: await hashValue(metrics),
      localLoadHash: await hashValue(localLoads),
      fontFaceSetHash: await hashValue(loadedFamilies),
      fontFaceSetStatus: fontSet?.status ?? null,
    },
  };
}

async function measureAudio() {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) return { supported: false };
  const context = new Offline(1, 5000, 44100);
  const oscillator = context.createOscillator();
  const compressor = context.createDynamicsCompressor();
  const analyser = context.createAnalyser();
  oscillator.type = 'triangle';
  oscillator.frequency.value = 10000;
  compressor.threshold.value = -50;
  compressor.knee.value = 40;
  compressor.ratio.value = 12;
  compressor.attack.value = 0;
  compressor.release.value = 0.25;
  analyser.fftSize = 2048;
  oscillator.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(context.destination);
  oscillator.start(0);
  const rendered = await context.startRendering();
  const channel = rendered.getChannelData(0);
  const copied = new Float32Array(channel.length);
  rendered.copyFromChannel(copied, 0);
  const byteFrequency = new Uint8Array(analyser.frequencyBinCount);
  const floatFrequency = new Float32Array(analyser.frequencyBinCount);
  const byteTime = new Uint8Array(analyser.fftSize);
  const floatTime = new Float32Array(analyser.fftSize);
  analyser.getByteFrequencyData(byteFrequency);
  analyser.getFloatFrequencyData(floatFrequency);
  analyser.getByteTimeDomainData(byteTime);
  analyser.getFloatTimeDomainData(floatTime);
  let latency = null;
  const Realtime = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (Realtime) {
    const realtime = new Realtime();
    latency = { base: round(realtime.baseLatency ?? null), output: round(realtime.outputLatency ?? null) };
    await realtime.close().catch(() => undefined);
  }
  const bytes = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  return {
    supported: true,
    readings: {
      sampleRate: rendered.sampleRate,
      channels: rendered.numberOfChannels,
      length: rendered.length,
      duration: round(rendered.duration),
      channelHash: await hashBytes(bytes(channel)),
      copyFromChannelHash: await hashBytes(bytes(copied)),
      analyserByteFrequencyHash: await hashBytes(byteFrequency),
      analyserFloatFrequencyHash: await hashBytes(bytes(floatFrequency)),
      analyserByteTimeHash: await hashBytes(byteTime),
      analyserFloatTimeHash: await hashBytes(bytes(floatTime)),
      latency,
    },
  };
}

function shaderPrecision(gl, shaderType) {
  return ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT'].map((name) => {
    const value = gl.getShaderPrecisionFormat(shaderType, gl[name]);
    return [name, value?.rangeMin ?? null, value?.rangeMax ?? null, value?.precision ?? null];
  });
}

async function measureWebGl(makeCanvas, type) {
  if (!makeCanvas) return { supported: false };
  const canvas = makeCanvas(96, 96);
  const gl = canvas.getContext(type, { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return { supported: false };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(vertex, 'attribute vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }');
  gl.shaderSource(fragment, 'precision highp float; void main(){ gl_FragColor=vec4(gl_FragCoord.x/97.0,gl_FragCoord.y/89.0,sin(gl_FragCoord.x)*0.5+0.5,1.0); }');
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(96 * 96 * 4);
  gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const limits = {};
  for (const name of ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VERTEX_ATTRIBS', 'MAX_VIEWPORT_DIMS', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE']) {
    const value = gl.getParameter(gl[name]);
    limits[name] = ArrayBuffer.isView(value) ? [...value] : value;
  }
  return {
    supported: true,
    readings: {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      extensionsHash: await hashValue((gl.getSupportedExtensions() ?? []).sort()),
      limitsHash: await hashValue(limits),
      vertexPrecisionHash: await hashValue(shaderPrecision(gl, gl.VERTEX_SHADER)),
      fragmentPrecisionHash: await hashValue(shaderPrecision(gl, gl.FRAGMENT_SHADER)),
      imageHash: await hashBytes(pixels),
    },
  };
}

async function measureWebGpu() {
  if (!navigator.gpu) return { supported: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false };
    const info = adapter.info ? Object.fromEntries(Object.entries(adapter.info)) : null;
    const limits = {};
    const limitKeys = [
      'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
      'maxTextureArrayLayers', 'maxBindGroups', 'maxBindGroupsPlusVertexBuffers',
      'maxBindingsPerBindGroup', 'maxDynamicUniformBuffersPerPipelineLayout',
      'maxDynamicStorageBuffersPerPipelineLayout', 'maxSampledTexturesPerShaderStage',
      'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
      'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage',
      'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize',
      'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
      'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes',
      'maxVertexBufferArrayStride', 'maxInterStageShaderComponents',
      'maxInterStageShaderVariables', 'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
      'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
      'maxComputeWorkgroupsPerDimension',
    ];
    for (const key of limitKeys) {
      const value = adapter.limits[key];
      if (typeof value === 'number') limits[key] = value;
    }
    const features = [...adapter.features].sort();
    return {
      supported: true,
      readings: {
        infoHash: await hashValue(info),
        infoPresent: info !== null,
        featuresHash: await hashValue(features),
        featuresCount: features.length,
        limitsHash: await hashValue(limits),
        limitsCount: Object.keys(limits).length,
        isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      },
    };
  } catch (error) {
    return { supported: false, reason: error?.name ?? 'request-failed' };
  }
}

async function measureClientRects() {
  if (typeof document === 'undefined') return { supported: false };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:217.25px;font:15.75px Arial;letter-spacing:.13px;line-height:19.5px;';
  host.innerHTML = '<span>MKT rect fingerprint wraps across several words 0123456789</span>';
  document.body.appendChild(host);
  const box = host.getBoundingClientRect();
  const rects = [...host.firstElementChild.getClientRects()].map((rect) => [round(rect.x), round(rect.y), round(rect.width), round(rect.height)]);
  host.remove();
  return {
    supported: true,
    readings: {
      bounding: [round(box.x), round(box.y), round(box.width), round(box.height)],
      clientRectsHash: await hashValue(rects),
    },
  };
}

async function measureUaClientHints() {
  let highEntropy = null;
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      highEntropy = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'brands', 'formFactors', 'fullVersionList', 'mobile', 'model', 'platform', 'platformVersion', 'uaFullVersion', 'wow64']);
    } catch (error) {
      highEntropy = { error: error?.name ?? 'unavailable' };
    }
  }
  const plugins = [...(navigator.plugins ?? [])].map((plugin) => ({ name: plugin.name, filename: plugin.filename, description: plugin.description }));
  const mimeTypes = [...(navigator.mimeTypes ?? [])].map((mime) => ({ type: mime.type, suffixes: mime.suffixes }));
  return {
    supported: true,
    readings: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      webdriver: navigator.webdriver,
      highEntropyHash: await hashValue(highEntropy),
      pluginsHash: await hashValue(plugins),
      mimeTypesHash: await hashValue(mimeTypes),
    },
  };
}

async function measureScreenLocale() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    supported: true,
    readings: {
      languages: [...navigator.languages],
      language: navigator.language,
      timezone: resolved.timeZone,
      calendar: resolved.calendar,
      numberingSystem: resolved.numberingSystem,
      dateSample: new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long', timeZone: resolved.timeZone }).format(new Date('2024-04-05T13:14:15Z')),
      numberSample: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(123456.789),
      screen: typeof screen === 'undefined' ? null : {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      devicePixelRatio: globalThis.devicePixelRatio ?? null,
    },
  };
}

async function measureContext(context, options = {}) {
  const makeCanvas = canvasFactory(options.forceOffscreen === true);
  const surfaces = options.forceOffscreen
    ? {
        canvas: await measureCanvas(makeCanvas),
        webgl1: await measureWebGl(makeCanvas, 'webgl'),
        webgl2: await measureWebGl(makeCanvas, 'webgl2'),
      }
    : {
        fonts: await measureFonts(makeCanvas),
        audio: await measureAudio(),
        webgl1: await measureWebGl(makeCanvas, 'webgl'),
        webgl2: await measureWebGl(makeCanvas, 'webgl2'),
        webgpu: await measureWebGpu(),
        canvas: await measureCanvas(makeCanvas),
        clientRects: await measureClientRects(),
        uaClientHints: await measureUaClientHints(),
        screenLocale: await measureScreenLocale(),
      };
  surfaces.aggregate = { supported: true, readings: { hash: await hashValue(surfaces) } };
  return { context, surfaces };
}

globalThis.__mktMeasureFingerprintContext = measureContext;
`;
}

function pageSource() {
  return `
async function measureIframe() {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = '/frame.html';
  document.body.appendChild(frame);
  await new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', reject, { once: true });
  });
  try {
    return await frame.contentWindow.__mktMeasureFingerprintContext('iframe');
  } finally {
    frame.remove();
  }
}

async function measureWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js');
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker-timeout')); }, 30000);
    worker.addEventListener('message', (event) => { clearTimeout(timer); worker.terminate(); resolve(event.data); }, { once: true });
    worker.addEventListener('error', (error) => { clearTimeout(timer); worker.terminate(); reject(error); }, { once: true });
    worker.postMessage('measure');
  });
}

globalThis.__runFingerprintMeasurement = async () => ({
  schemaVersion: 1,
  contexts: {
    document: await globalThis.__mktMeasureFingerprintContext('document'),
    iframe: await measureIframe(),
    worker: await measureWorker(),
    offscreenCanvas: await globalThis.__mktMeasureFingerprintContext('offscreenCanvas', { forceOffscreen: true }),
  },
});
`;
}

function workerSource() {
  return `
importScripts('/probe-runtime.js');
self.onmessage = async () => {
  try {
    self.postMessage(await self.__mktMeasureFingerprintContext('worker'));
  } catch (error) {
    self.postMessage({ context: 'worker', error: error?.name ?? 'worker-failed', surfaces: {} });
  }
};
`;
}

function buildProbeAssets() {
  return {
    "/probe-runtime.js": { type: "text/javascript; charset=utf-8", body: runtimeSource() },
    "/probe-page.js": { type: "text/javascript; charset=utf-8", body: pageSource() },
    "/worker.js": { type: "text/javascript; charset=utf-8", body: workerSource() },
    "/probe.html": {
      type: "text/html; charset=utf-8",
      body: '<!doctype html><meta charset="utf-8"><title>MKT fingerprint probe</title><script src="/probe-runtime.js"></script><script src="/probe-page.js"></script>',
    },
    "/frame.html": {
      type: "text/html; charset=utf-8",
      body: '<!doctype html><meta charset="utf-8"><title>MKT fingerprint frame</title><script src="/probe-runtime.js"></script>',
    },
  };
}

module.exports = { buildProbeAssets };
