FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    CLOVER_MODELS_DIR=/app/models_cache \
    CLOVER_DATA_DIR=/app/data

# Install Tesseract OCR (for scanned 0-text PDFs), QPDF (for pikepdf linearization), and OpenMP (for ONNX Runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    qpdf \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && if [ ! -d "/usr/share/tesseract-ocr/5/tessdata" ] && [ -d "/usr/share/tesseract-ocr/4.00/tessdata" ]; then \
         mkdir -p /usr/share/tesseract-ocr/5 && ln -s /usr/share/tesseract-ocr/4.00/tessdata /usr/share/tesseract-ocr/5/tessdata; \
       fi

# Hugging Face Spaces run containers as non-root uid=1000
RUN useradd -m -u 1000 user

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

COPY --chown=user:user preload_models.py /app/preload_models.py
RUN mkdir -p /app/models_cache /app/data && chown -R user:user /app

USER user
ENV HOME=/home/user \
    PATH="/home/user/.local/bin:${PATH}"

# Bake & QInt8-quantize IBM Granite 278M + MS-MARCO Cross-Encoder at image build time
RUN python /app/preload_models.py

COPY --chown=user:user chunker.py models.py search_index.py pdf_processor.py app.py /app/

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]

