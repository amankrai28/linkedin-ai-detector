# Fakespot RoBERTa AI Detector — ONNX (Quantized INT8)

Quantized ONNX export of [fakespot-ai/roberta-base-ai-text-detection-v1](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1) for use with [Transformers.js](https://github.com/huggingface/transformers.js).

## Upload Instructions

1. Create a new HuggingFace repository:
   ```bash
   huggingface-cli login
   huggingface-cli repo create fakespot-roberta-ai-detector-onnx --type model
   ```

2. Clone and push all files from this directory:
   ```bash
   git clone https://huggingface.co/YOUR_USERNAME/fakespot-roberta-ai-detector-onnx
   cp -r benchmark/hf-upload/* fakespot-roberta-ai-detector-onnx/
   cd fakespot-roberta-ai-detector-onnx
   git lfs install
   git lfs track "*.onnx"
   git add .
   git commit -m "Add quantized ONNX model for Transformers.js"
   git push
   ```

3. Update `offscreen.js` with your repo ID:
   ```javascript
   pipeline('text-classification', 'YOUR_USERNAME/fakespot-roberta-ai-detector-onnx', { dtype: 'q8' })
   ```

## Model Details

- **Source**: fakespot-ai/roberta-base-ai-text-detection-v1
- **Architecture**: RoBERTa-base (125M params)
- **Quantization**: INT8 dynamic (avx512_vnni via Optimum)
- **Size**: ~120MB (q8) vs ~499MB (fp32)
- **Labels**: `{0: "Human", 1: "AI"}`
- **License**: Apache 2.0
