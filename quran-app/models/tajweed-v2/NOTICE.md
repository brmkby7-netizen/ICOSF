# Tajweed v2 speech model

`model-int8.onnx` and `config.json` come from **HisnLabs/tajweed-v2** (https://huggingface.co/Hisnlabs/tajweed-v2),
licensed under the **Apache License 2.0** (https://www.apache.org/licenses/LICENSE-2.0). The model is built on
Tarteel's `tarteel-ai/whisper-base-ar-quran`. It is redistributed unmodified (`config.json` keeps only the symbol list).

The recitation checker in `js/recite/engine.js` is a JavaScript port of the model's bundled rule engine (`imam.py`,
same licence), adapted for phones. The expected pronunciation in `data/phonetic/` was generated with that rule engine
and the `quran-transcript` phonetizer (MIT, https://github.com/obadx/quran-transcript).
