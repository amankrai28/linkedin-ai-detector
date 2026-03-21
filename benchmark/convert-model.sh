#!/bin/bash
# Converts fakespot-ai/roberta-base-ai-text-detection-v1 to quantized ONNX
# for use with Transformers.js in the LinkedIn AI Detector extension.
#
# Usage: bash benchmark/convert-model.sh
# Output: benchmark/hf-upload/ with all files ready for HuggingFace upload.
#
# Prerequisites: Python 3.8+ (usually pre-installed on macOS)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$SCRIPT_DIR/tmp-convert"
UPLOAD_DIR="$SCRIPT_DIR/hf-upload"

echo "=== Step 1/4: Installing Python dependencies ==="
pip3 install --quiet torch transformers optimum onnxruntime

echo "=== Step 2/4: Exporting model to ONNX ==="
rm -rf "$WORK_DIR"
python3 -c "
from optimum.exporters.onnx import main_export
main_export('fakespot-ai/roberta-base-ai-text-detection-v1', '$WORK_DIR/onnx-fp32/', task='text-classification')
"

echo "=== Step 3/4: Quantizing to INT8 ==="
python3 -c "
from optimum.onnxruntime import ORTQuantizer, AutoQuantizationConfig
q = ORTQuantizer.from_pretrained('$WORK_DIR/onnx-fp32/')
q.quantize(
    save_dir='$WORK_DIR/onnx-q8/',
    quantization_config=AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False)
)
"

echo "=== Step 4/4: Assembling upload directory ==="
# Copy tokenizer/config files (small files already in hf-upload/ from git,
# but regenerate from source to ensure they're fresh)
cp "$WORK_DIR/onnx-q8/config.json" "$UPLOAD_DIR/"
cp "$WORK_DIR/onnx-q8/tokenizer.json" "$UPLOAD_DIR/"
cp "$WORK_DIR/onnx-q8/tokenizer_config.json" "$UPLOAD_DIR/"
cp "$WORK_DIR/onnx-q8/special_tokens_map.json" "$UPLOAD_DIR/"
cp "$WORK_DIR/onnx-q8/vocab.json" "$UPLOAD_DIR/"
cp "$WORK_DIR/onnx-q8/merges.txt" "$UPLOAD_DIR/"

# Place ONNX model in onnx/ subdirectory (Transformers.js convention)
mkdir -p "$UPLOAD_DIR/onnx"
cp "$WORK_DIR/onnx-q8/model_quantized.onnx" "$UPLOAD_DIR/onnx/"

# Clean up temp files
rm -rf "$WORK_DIR"

echo ""
echo "=== Done! ==="
echo "Upload directory ready at: $UPLOAD_DIR"
echo ""
echo "Next steps:"
echo "  1. Go to https://huggingface.co/new and create a model repo"
echo "  2. Upload ALL files from $UPLOAD_DIR (including onnx/ subfolder)"
echo "  3. Update the model ID in offscreen.js if your HF username differs from amankrai28"
