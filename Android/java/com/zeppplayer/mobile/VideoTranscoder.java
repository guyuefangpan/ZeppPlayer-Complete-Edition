package com.zeppplayer.mobile;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.view.Surface;

import java.io.File;
import java.nio.ByteBuffer;

/* Re-encodes a WebM recording into an MP4/H.264 file. WebViews older than
 * Chromium 126 can only record WebM, which many phone galleries refuse to
 * open, so the APK converts the clip with the platform codecs before it is
 * written to the gallery. */
public final class VideoTranscoder {
    private static final long TIMEOUT_US = 10_000L;
    private static final long MAX_WALL_MS = 180_000L;
    private static final long EOS_FALLBACK_MS = 1_500L;
    private static final long EOS_GIVEUP_MS = 4_000L;

    private VideoTranscoder() {}

    public static boolean transcode(File in, File out) {
        MediaExtractor extractor = null;
        MediaCodec decoder = null;
        MediaCodec encoder = null;
        Surface surface = null;
        MediaMuxer muxer = null;
        boolean muxerStarted = false;
        boolean encoderDone = false;

        try {
            extractor = new MediaExtractor();
            extractor.setDataSource(in.getAbsolutePath());

            int track = -1;
            MediaFormat srcFormat = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    track = i;
                    srcFormat = f;
                    break;
                }
            }
            if (track < 0 || srcFormat == null) return false;
            extractor.selectTrack(track);

            int width = srcFormat.getInteger(MediaFormat.KEY_WIDTH);
            int height = srcFormat.getInteger(MediaFormat.KEY_HEIGHT);
            if (width <= 0 || height <= 0) return false;
            // H.264 encoders reject odd dimensions.
            width -= width % 2;
            height -= height % 2;

            int frameRate = 30;
            try {
                if (srcFormat.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                    int rate = srcFormat.getInteger(MediaFormat.KEY_FRAME_RATE);
                    if (rate > 0 && rate <= 60) frameRate = rate;
                }
            } catch (Exception ignored) {}

            MediaFormat encFormat = MediaFormat.createVideoFormat("video/avc", width, height);
            encFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            encFormat.setInteger(MediaFormat.KEY_BIT_RATE,
                    Math.max(1_500_000, width * height * 6));
            encFormat.setInteger(MediaFormat.KEY_FRAME_RATE, frameRate);
            encFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);

            encoder = MediaCodec.createEncoderByType("video/avc");
            encoder.configure(encFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            surface = encoder.createInputSurface();
            encoder.start();

            String srcMime = srcFormat.getString(MediaFormat.KEY_MIME);
            decoder = MediaCodec.createDecoderByType(srcMime);
            decoder.configure(srcFormat, surface, null, 0);
            decoder.start();

            muxer = new MediaMuxer(out.getAbsolutePath(),
                    MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int muxTrack = -1;
            boolean inputDone = false;
            boolean decoderDone = false;
            boolean eosSignaled = false;
            long lastOutput = System.currentTimeMillis();
            long deadline = System.currentTimeMillis() + MAX_WALL_MS;

            while (!encoderDone && System.currentTimeMillis() < deadline) {
                if (!inputDone) {
                    int inIdx = decoder.dequeueInputBuffer(TIMEOUT_US);
                    if (inIdx >= 0) {
                        ByteBuffer buffer = decoder.getInputBuffer(inIdx);
                        int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
                        if (size < 0) {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            decoder.queueInputBuffer(inIdx, 0, size,
                                    extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }

                if (!decoderDone) {
                    int outIdx = decoder.dequeueOutputBuffer(info, TIMEOUT_US);
                    if (outIdx >= 0) {
                        boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                        // Rendering the frame also forwards it (and its
                        // timestamp) to the encoder input surface.
                        decoder.releaseOutputBuffer(outIdx, true);
                        if (eos) decoderDone = true;
                    }
                }

                int encIdx = encoder.dequeueOutputBuffer(info, TIMEOUT_US);
                if (encIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (muxerStarted) return false;
                    muxTrack = muxer.addTrack(encoder.getOutputFormat());
                    muxer.start();
                    muxerStarted = true;
                } else if (encIdx >= 0) {
                    lastOutput = System.currentTimeMillis();
                    ByteBuffer buffer = encoder.getOutputBuffer(encIdx);
                    if (buffer != null && info.size > 0) {
                        if (!muxerStarted) return false;
                        buffer.position(info.offset);
                        buffer.limit(info.offset + info.size);
                        muxer.writeSampleData(muxTrack, buffer, info);
                    }
                    encoder.releaseOutputBuffer(encIdx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        encoderDone = true;
                    }
                }

                // Some codecs never forward the end-of-stream flag through the
                // shared surface; close the encoder explicitly instead of
                // waiting for the wall-clock deadline.
                long idle = System.currentTimeMillis() - lastOutput;
                if (!encoderDone && decoderDone && !eosSignaled && idle > EOS_FALLBACK_MS) {
                    try { encoder.signalEndOfInputStream(); } catch (Exception ignored) {}
                    eosSignaled = true;
                    lastOutput = System.currentTimeMillis();
                }
                if (!encoderDone && eosSignaled
                        && System.currentTimeMillis() - lastOutput > EOS_GIVEUP_MS) {
                    break;
                }
            }
            return encoderDone && muxerStarted;
        } catch (Exception e) {
            return false;
        } finally {
            if (decoder != null) {
                try { decoder.stop(); } catch (Exception ignored) {}
                decoder.release();
            }
            if (encoder != null) {
                try { encoder.stop(); } catch (Exception ignored) {}
                encoder.release();
            }
            if (surface != null) surface.release();
            if (muxer != null) {
                try {
                    if (muxerStarted) muxer.stop();
                } catch (Exception ignored) {}
                muxer.release();
            }
        }
    }
}
