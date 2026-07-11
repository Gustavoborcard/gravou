import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  BufferTarget,
  Conversion,
  Mp4OutputFormat,
  WebMOutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  VideoSampleSink,
  VideoSampleSource,
  getFirstEncodableVideoCodec
} from "./vendor/mediabunny.min.mjs";

const jobs = new Map();
const EPSILON = 1e-7;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeError(error) {
  return {
    code: error && error.code ? String(error.code) : "processing_failed",
    message: error && error.message ? String(error.message) : "Falha ao preparar o replay."
  };
}

function reportProgress(job, jobId, progress) {
  const safe = Math.max(0, Math.min(1, Number(progress) || 0));
  const percent = Math.floor(safe * 100);
  if (percent >= job.lastProgress + 5 || percent === 100) {
    job.lastProgress = percent;
    self.postMessage({ type: "progress", jobId, progress: safe });
  }
}

async function chooseLosslessCut(videoTrack, audioTrack, firstTimestamp, endTimestamp, targetSeconds) {
  const videoSink = new EncodedPacketSink(videoTrack);
  const audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;
  const earliest = Math.max(firstTimestamp, endTimestamp - targetSeconds * 1.1);
  const latest = Math.max(earliest, endTimestamp - targetSeconds * 0.9);

  let key = await videoSink.getKeyPacket(earliest, { verifyKeyPackets: true });
  if (!key) key = await videoSink.getFirstKeyPacket({ verifyKeyPackets: true });
  if (!key) {
    throw codedError("missing_keyframe", "A gravação não contém um quadro-chave utilizável.");
  }

  const groups = [];
  for (let guard = 0; key && guard < 10000; guard++) {
    const next = await videoSink.getNextKeyPacket(key, { verifyKeyPackets: true });
    groups.push({ key, next });
    if (key.timestamp > latest + EPSILON) break;
    if (!next || next.sequenceNumber === key.sequenceNumber) break;
    key = next;
  }

  const candidates = [];
  for (const group of groups) {
    if (group.key.timestamp >= endTimestamp) continue;

    let videoStart = group.key.timestamp;
    for await (const packet of videoSink.packets(group.key, group.next || undefined, { metadataOnly: true })) {
      videoStart = Math.min(videoStart, packet.timestamp);
    }

    let audioStartPacket = null;
    if (audioSink) {
      audioStartPacket = await audioSink.getPacket(videoStart);
      if (audioStartPacket && audioStartPacket.timestamp + audioStartPacket.duration <= videoStart + EPSILON) {
        audioStartPacket = await audioSink.getNextPacket(audioStartPacket);
      }
      if (!audioStartPacket) {
        audioStartPacket = await audioSink.getFirstPacket();
      }
      if (!audioStartPacket || audioStartPacket.timestamp >= endTimestamp) {
        throw codedError("missing_audio_window", "A faixa de áudio não cobre o trecho solicitado.");
      }
    }

    const baseTimestamp = Math.min(
      videoStart,
      audioStartPacket ? audioStartPacket.timestamp : videoStart
    );
    const predictedDuration = endTimestamp - baseTimestamp;

    if (
      predictedDuration >= targetSeconds * 0.9 - EPSILON &&
      predictedDuration <= targetSeconds * 1.1 + EPSILON
    ) {
      candidates.push({
        videoSink,
        audioSink,
        videoStartPacket: group.key,
        audioStartPacket,
        baseTimestamp,
        predictedDuration
      });
    }
  }

  if (!candidates.length) {
    throw codedError(
      "keyframe_outside_tolerance",
      "Não há um quadro-chave que permita o corte dentro da tolerância."
    );
  }

  candidates.sort((a, b) => {
    const difference = Math.abs(a.predictedDuration - targetSeconds) - Math.abs(b.predictedDuration - targetSeconds);
    return difference || b.baseTimestamp - a.baseTimestamp;
  });
  return candidates[0];
}

async function trimLosslessly(params) {
  const {
    job,
    jobId,
    input,
    videoTrack,
    audioTrack,
    firstTimestamp,
    endTimestamp,
    targetSeconds,
    format
  } = params;

  reportProgress(job, jobId, 0.02);
  const cut = await chooseLosslessCut(
    videoTrack,
    audioTrack,
    firstTimestamp,
    endTimestamp,
    targetSeconds
  );
  if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");

  const videoCodec = await videoTrack.getCodec();
  const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
  if (!videoCodec) {
    throw codedError("unknown_video_codec", "O codec de vídeo da gravação não foi reconhecido.");
  }
  if (audioTrack && !audioCodec) {
    throw codedError("unknown_audio_codec", "O codec de áudio da gravação não foi reconhecido.");
  }

  const target = new BufferTarget();
  const output = new Output({ format, target });
  job.output = output;

  const videoSource = new EncodedVideoPacketSource(videoCodec);
  output.addVideoTrack(videoSource, { rotation: await videoTrack.getRotation() });

  let audioSource = null;
  if (audioTrack) {
    audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const duration = Math.max(EPSILON, endTimestamp - cut.baseTimestamp);
  const videoPump = (async () => {
    const decoderConfig = await videoTrack.getDecoderConfig();
    let count = 0;
    try {
      for await (const packet of cut.videoSink.packets(
        cut.videoStartPacket,
        undefined,
        { verifyKeyPackets: true }
      )) {
        if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");
        const timestamp = packet.timestamp - cut.baseTimestamp;
        if (timestamp < -EPSILON) {
          throw codedError("negative_video_timestamp", "O fluxo de vídeo não pôde ser realinhado com segurança.");
        }
        await videoSource.add(
          packet.clone({ timestamp: Math.max(0, timestamp) }),
          count === 0 ? { decoderConfig: decoderConfig || undefined } : undefined
        );
        count++;
        reportProgress(job, jobId, 0.05 + 0.85 * Math.min(1, (timestamp + packet.duration) / duration));
      }
      if (!count) {
        throw codedError("empty_video_output", "Nenhum quadro de vídeo foi gerado.");
      }
    } finally {
      videoSource.close();
    }
    return count;
  })();

  const audioPump = audioTrack ? (async () => {
    const decoderConfig = await audioTrack.getDecoderConfig();
    let count = 0;
    try {
      for await (const packet of cut.audioSink.packets(cut.audioStartPacket)) {
        if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");
        const timestamp = packet.timestamp - cut.baseTimestamp;
        if (timestamp < -EPSILON) {
          throw codedError("negative_audio_timestamp", "O fluxo de áudio não pôde ser realinhado com segurança.");
        }
        await audioSource.add(
          packet.clone({ timestamp: Math.max(0, timestamp) }),
          count === 0 ? { decoderConfig: decoderConfig || undefined } : undefined
        );
        count++;
      }
      if (!count) {
        throw codedError("empty_audio_output", "Nenhum pacote de áudio foi gerado.");
      }
    } finally {
      audioSource.close();
    }
    return count;
  })() : Promise.resolve(0);

  try {
    await Promise.all([videoPump, audioPump]);
    if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");
    await output.finalize();
  } catch (error) {
    try { await output.cancel(); } catch (_) {}
    throw error;
  }

  if (!(target.buffer instanceof ArrayBuffer) || !target.buffer.byteLength) {
    throw codedError("empty_output", "O processador gerou um arquivo vazio.");
  }

  reportProgress(job, jobId, 0.94);
  return target.buffer;
}

async function trimVideoWithCopiedAudio(params) {
  const {
    job,
    jobId,
    videoTrack,
    audioTrack,
    firstTimestamp,
    endTimestamp,
    targetSeconds,
    format
  } = params;

  const startTimestamp = Math.max(firstTimestamp, endTimestamp - targetSeconds);
  const sourceVideoCodec = await videoTrack.getCodec();
  if (!sourceVideoCodec) {
    throw codedError("unknown_video_codec", "O codec de vídeo da gravação não foi reconhecido.");
  }

  const codedWidth = await videoTrack.getCodedWidth();
  const codedHeight = await videoTrack.getCodedHeight();
  const rotation = await videoTrack.getRotation();
  const bakeRotation = rotation !== 0 && !format.supportsVideoRotationMetadata;
  const width = bakeRotation && rotation % 180 !== 0 ? codedHeight : codedWidth;
  const height = bakeRotation && rotation % 180 !== 0 ? codedWidth : codedHeight;
  let sourceBitrate = null;
  try { sourceBitrate = await videoTrack.getAverageBitrate(); } catch (_) {}
  const bitrate = Number.isFinite(sourceBitrate) && sourceBitrate > 0
    ? Math.max(2500000, Math.min(8000000, Math.round(sourceBitrate * 1.5)))
    : 4000000;

  const supportedCodecs = format.getSupportedVideoCodecs();
  const preferredCodecs = supportedCodecs.includes(sourceVideoCodec)
    ? [sourceVideoCodec, ...supportedCodecs.filter(codec => codec !== sourceVideoCodec)]
    : supportedCodecs;
  const outputVideoCodec = await getFirstEncodableVideoCodec(preferredCodecs, {
    width,
    height,
    bitrate
  });
  if (!outputVideoCodec) {
    throw codedError(
      "video_reencode_unsupported",
      "Este navegador não oferece um codificador de vídeo compatível."
    );
  }

  const target = new BufferTarget();
  const output = new Output({ format, target });
  job.output = output;

  const videoEncoding = {
    codec: outputVideoCodec,
    bitrate,
    keyFrameInterval: 1
  };
  if (bakeRotation) videoEncoding.transform = { force: true };

  const videoSource = new VideoSampleSource(videoEncoding);
  output.addVideoTrack(videoSource, { rotation: bakeRotation ? 0 : rotation });

  let audioSource = null;
  let audioSink = null;
  let audioStartPacket = null;
  if (audioTrack) {
    const audioCodec = await audioTrack.getCodec();
    if (!audioCodec) {
      throw codedError("unknown_audio_codec", "O codec de áudio da gravação não foi reconhecido.");
    }

    audioSink = new EncodedPacketSink(audioTrack);
    audioStartPacket = await audioSink.getPacket(startTimestamp);
    if (!audioStartPacket) {
      audioStartPacket = await audioSink.getFirstPacket();
    } else if (audioStartPacket.timestamp < startTimestamp - EPSILON) {
      audioStartPacket = await audioSink.getNextPacket(audioStartPacket);
    }
    if (!audioStartPacket || audioStartPacket.timestamp >= endTimestamp) {
      throw codedError("missing_audio_window", "A faixa de áudio não cobre o trecho solicitado.");
    }

    audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);
  }

  try {
    await output.start();

    const videoPump = (async () => {
      const sink = new VideoSampleSink(videoTrack);
      let count = 0;
      try {
        for await (const sample of sink.samples(startTimestamp, endTimestamp)) {
          if (job.cancelled) {
            sample.close();
            throw codedError("cancelled", "Preparação cancelada.");
          }
          try {
            const timestamp = Math.max(0, sample.timestamp - startTimestamp);
            sample.setTimestamp(timestamp);
            await videoSource.add(sample);
            count++;
            reportProgress(
              job,
              jobId,
              0.05 + 0.85 * Math.min(1, (timestamp + sample.duration) / targetSeconds)
            );
          } finally {
            sample.close();
          }
        }
        if (!count) {
          throw codedError("empty_video_output", "Nenhum quadro de vídeo foi gerado.");
        }
      } finally {
        videoSource.close();
      }
      return count;
    })();

    const audioPump = audioTrack ? (async () => {
      const decoderConfig = await audioTrack.getDecoderConfig();
      let count = 0;
      try {
        for await (const packet of audioSink.packets(audioStartPacket)) {
          if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");
          const timestamp = packet.timestamp - startTimestamp;
          if (timestamp < -EPSILON) continue;
          await audioSource.add(
            packet.clone({ timestamp: Math.max(0, timestamp) }),
            count === 0 ? { decoderConfig: decoderConfig || undefined } : undefined
          );
          count++;
        }
        if (!count) {
          throw codedError("empty_audio_output", "Nenhum pacote de áudio foi gerado.");
        }
      } finally {
        audioSource.close();
      }
      return count;
    })() : Promise.resolve(0);

    await Promise.all([videoPump, audioPump]);
    if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");
    await output.finalize();
  } catch (error) {
    try { await output.cancel(); } catch (_) {}
    throw error;
  }

  if (!(target.buffer instanceof ArrayBuffer) || !target.buffer.byteLength) {
    throw codedError("empty_output", "O processador gerou um arquivo vazio.");
  }
  return target.buffer;
}

async function trimWithFullTranscode(params) {
  const {
    job,
    jobId,
    input,
    videoTrack,
    audioTrack,
    firstTimestamp,
    endTimestamp,
    targetSeconds,
    format
  } = params;

  const target = new BufferTarget();
  const output = new Output({ format, target });
  job.output = output;

  const options = {
    input,
    output,
    tracks: "primary",
    trim: {
      start: Math.max(firstTimestamp, endTimestamp - targetSeconds),
      end: endTimestamp
    },
    video: { forceTranscode: true },
    showWarnings: false
  };
  if (audioTrack) options.audio = { forceTranscode: true };

  job.conversion = await Conversion.init(options);
  if (job.cancelled) {
    await job.conversion.cancel();
    throw codedError("cancelled", "Preparação cancelada.");
  }
  if (!job.conversion.isValid) {
    const reasons = job.conversion.discardedTracks
      .map(entry => entry.reason)
      .filter(Boolean)
      .join(",");
    throw codedError(
      "transcode_unsupported",
      reasons || "Este navegador não oferece a recodificação necessária."
    );
  }
  if (!job.conversion.utilizedTracks.includes(videoTrack)) {
    throw codedError("video_discarded", "A faixa de vídeo seria descartada.");
  }
  if (audioTrack && !job.conversion.utilizedTracks.includes(audioTrack)) {
    throw codedError("audio_discarded", "A faixa de áudio seria descartada.");
  }

  job.conversion.onProgress = progress => reportProgress(job, jobId, progress);
  await job.conversion.execute();
  if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");

  if (!(target.buffer instanceof ArrayBuffer) || !target.buffer.byteLength) {
    throw codedError("empty_output", "O processador gerou um arquivo vazio.");
  }
  return target.buffer;
}

async function validateOutputBuffer(buffer, mime, targetSeconds, requireAudio) {
  const check = new Input({
    source: new BlobSource(new Blob([buffer], { type: mime })),
    formats: ALL_FORMATS
  });

  try {
    if (!(await check.canRead())) {
      throw codedError("unreadable_output", "O arquivo preparado não pôde ser relido.");
    }
    const videoTrack = await check.getPrimaryVideoTrack();
    const audioTrack = await check.getPrimaryAudioTrack();
    if (!videoTrack) {
      throw codedError("missing_output_video", "O replay preparado não contém vídeo.");
    }
    if (requireAudio && !audioTrack) {
      throw codedError("missing_output_audio", "O replay preparado perdeu a faixa de áudio.");
    }
    if (!(await videoTrack.getDisplayWidth()) || !(await videoTrack.getDisplayHeight())) {
      throw codedError("invalid_output_dimensions", "O replay preparado tem dimensões inválidas.");
    }

    const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
    const first = await check.getFirstTimestamp(tracks);
    const end = await check.computeDuration(tracks);
    const duration = end - first;
    if (
      !Number.isFinite(duration) ||
      duration < targetSeconds * 0.9 ||
      duration > targetSeconds * 1.1
    ) {
      throw codedError("duration_out_of_range", "A duração preparada ficou fora da tolerância.");
    }
    return duration;
  } finally {
    try { check.dispose(); } catch (_) {}
  }
}

async function processTrim(message) {
  const { jobId, blob, targetSeconds, mime, forceTranscode } = message;
  const job = {
    cancelled: false,
    conversion: null,
    output: null,
    lastProgress: -1
  };
  jobs.set(jobId, job);
  let input = null;

  try {
    if (!(blob instanceof Blob) || !blob.size) {
      throw codedError("empty_blob", "O arquivo de origem está vazio.");
    }
    if (!(targetSeconds > 0)) {
      throw codedError("invalid_target", "A duração escolhida é inválida.");
    }

    input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS
    });

    if (!(await input.canRead())) {
      throw codedError("unreadable_input", "O navegador não reconheceu o arquivo gravado.");
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) {
      throw codedError("missing_video", "A gravação não contém uma faixa de vídeo.");
    }

    const selectedTracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
    const firstTimestamp = await input.getFirstTimestamp(selectedTracks);
    const endTimestamp = await input.computeDuration(selectedTracks);
    const rawDuration = Math.max(0, endTimestamp - firstTimestamp);

    if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
      throw codedError("invalid_duration", "Não foi possível medir a duração da gravação.");
    }
    if (rawDuration + 0.05 < targetSeconds * 0.9) {
      throw codedError("insufficient_history", "A gravação ainda não tinha histórico suficiente.");
    }

    if (
      !forceTranscode &&
      rawDuration >= targetSeconds * 0.9 &&
      rawDuration <= targetSeconds * 1.1
    ) {
      self.postMessage({ type: "passthrough", jobId, rawDuration });
      return;
    }

    const detectedFormat = await input.getFormat();
    const detectedMime = detectedFormat && detectedFormat.mimeType
      ? detectedFormat.mimeType
      : (mime || blob.type || "");
    const wantsMp4 = /mp4|quicktime/i.test(detectedMime);
    const createFormat = () => wantsMp4
      ? new Mp4OutputFormat({ fastStart: "in-memory" })
      : new WebMOutputFormat();

    let format = createFormat();
    const params = {
      job,
      jobId,
      input,
      videoTrack,
      audioTrack,
      firstTimestamp,
      endTimestamp,
      targetSeconds,
      format
    };

    let buffer;
    if (!forceTranscode) {
      buffer = await trimLosslessly(params);
    } else {
      try {
        buffer = await trimVideoWithCopiedAudio(params);
      } catch (hybridError) {
        if (job.cancelled || (hybridError && hybridError.code === "cancelled")) {
          throw hybridError;
        }
        job.output = null;
        job.conversion = null;
        format = createFormat();
        params.format = format;
        buffer = await trimWithFullTranscode(params);
      }
    }

    if (job.cancelled) throw codedError("cancelled", "Preparação cancelada.");

    const actualDuration = await validateOutputBuffer(
      buffer,
      format.mimeType,
      targetSeconds,
      !!audioTrack
    );
    reportProgress(job, jobId, 1);

    self.postMessage({
      type: "done",
      jobId,
      buffer,
      mime: format.mimeType,
      ext: String(format.fileExtension || "").replace(/^\./, ""),
      rawDuration,
      actualDuration
    }, [buffer]);
  } catch (error) {
    if (job.cancelled || (error && error.code === "cancelled")) {
      self.postMessage({ type: "cancelled", jobId });
    } else {
      self.postMessage({ type: "error", jobId, ...serializeError(error) });
    }
  } finally {
    jobs.delete(jobId);
    try { if (input) input.dispose(); } catch (_) {}
  }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "trim") {
    void processTrim(message);
    return;
  }
  if (message.type === "cancel") {
    const job = jobs.get(message.jobId);
    if (!job) return;
    job.cancelled = true;
    try {
      if (job.conversion) void job.conversion.cancel();
      else if (job.output) void job.output.cancel();
    } catch (_) {}
  }
};
