const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { SpeechClient } = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const path = require('path');
const fs = require('fs');
const util = require('util');
const fetch = require('node-fetch');

// 環境変数に含まれる JSON をパースして認証情報として使用
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sttClient = new SpeechClient({ credentials });
const ttsClient = new textToSpeech.TextToSpeechClient({ credentials });

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// DeepL API情報
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate'; // DeepLのAPIエンドポイント（無料版）

// DeepL翻訳関数
async function translateText(text, targetLang = 'JA') {
    const params = new URLSearchParams();
    params.append('auth_key', DEEPL_API_KEY);
    params.append('text', text);
    params.append('target_lang', targetLang);

    try {
        const res = await fetch(DEEPL_API_URL, {
            method: 'POST',
            body: params,
        });
        const json = await res.json();
        return json.translations[0]?.text || null;
    } catch (e) {
        console.error('DeepL error:', e);
        return null;
    }
}

async function synthesizeSpeech(text) {
    if (!text || text.trim() === '') {
        throw new Error('TTS: 空のテキストが渡されました');
    }
    const request = {
        input: { text },
        voice: { languageCode: 'en-US', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MP3' },
    };
    const [response] = await ttsClient.synthesizeSpeech(request);
    return response.audioContent.toString('base64');
}


app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
    console.log('Client connected');

    const recognizeStream = sttClient
        .streamingRecognize({
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 48000,
                languageCode: 'ja-JP',
                // alternativeLanguageCodes: ['en-US']
            },
            interimResults: true,
        })
        .on('error', (err) => {
            console.error('STT error:', err);
            ws.send(JSON.stringify({ error: err.message }));
        })
        .on('data', async (data) => {
            const result = data.results[0];
            const alt = result?.alternatives[0];
            if (!alt) return;

            const transcript = alt.transcript.trim();
            console.log('🟩 認識結果:', transcript);

            if (result.isFinal && transcript) {
                const translation = await translateText(transcript, 'EN');
                console.log('🟦 翻訳結果:', translation);

                if (translation?.trim()) {
                    const audioBase64 = await synthesizeSpeech(translation);
                    console.log('🟧 音声生成完了');

                    ws.send(JSON.stringify({
                        transcript,
                        isFinal: result.isFinal,
                        translation,
                        audio: audioBase64,
                    }));
                } else {
                    console.log('🟨 翻訳結果が空だったため、TTSスキップ');
                }
            }
        });

    ws.on('message', (message) => {
        if (message instanceof Buffer) {
            recognizeStream.write(message);
        }
    });

    ws.on('close', () => {
        recognizeStream.destroy();
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
