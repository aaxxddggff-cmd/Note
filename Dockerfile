FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8001 \
    TRUST_PROXY=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py push.py backup.py schema.sql ./
COPY static ./static

RUN useradd --system --uid 10001 app && mkdir -p /data && chown app /data
USER app
VOLUME /data
EXPOSE 8001

HEALTHCHECK --interval=1m --timeout=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/api/auth/status')"

CMD ["python", "server.py"]
