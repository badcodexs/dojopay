import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
const client = new TranscribeStreamingClient({ region: process.env.AWS_REGION || 'us-east-1' });

export const transcribeAudio = async (audioBytes: Uint8Array): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    try {
      async function* audioStream() {
        const chunkSize = 8 * 1024;
        for (let i = 0; i < audioBytes.length; i += chunkSize) {
          const end = Math.min(i + chunkSize, audioBytes.length);
          yield { AudioEvent: { AudioChunk: audioBytes.slice(i, end) } };
        }
      }

      const command = new StartStreamTranscriptionCommand({
        LanguageCode: "es-US",
        MediaEncoding: "ogg-opus",
        MediaSampleRateHertz: 48000,
        AudioStream: audioStream(),
      });

      const response = await client.send(command);

      let transcribedText = "";

      if (response.TranscriptResultStream) {
        for await (const event of response.TranscriptResultStream) {
          if (event.TranscriptEvent) {
            const results = event.TranscriptEvent.Transcript?.Results;
            if (results && results.length > 0) {
              for (const result of results) {
                if (!result.IsPartial) {
                  const alt = result.Alternatives?.[0];
                  if (alt?.Transcript) {
                    transcribedText += alt.Transcript + " ";
                  }
                }
              }
            }
          }
        }
      }

      resolve(transcribedText.trim());
    } catch (error) {
      console.error("Error en Transcribe Streaming:", error);
      reject(error);
    }
  });
};
