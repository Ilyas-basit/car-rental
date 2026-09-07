"""Local OCR API adapted from https://github.com/nahlibee/OCR-rex.

The original project saves uploads to author-specific Windows paths and writes
results to its own database. This service keeps its PaddleOCR approach but
returns extracted text directly to the rental dashboard.
"""

import os
from threading import Lock

import cv2
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024
CORS(app, resources={r"/*": {"origins": "*"}})

_ocr = None
_ocr_lock = Lock()


def get_ocr():
    global _ocr
    if _ocr is None:
        with _ocr_lock:
            if _ocr is None:
                from paddleocr import PaddleOCR

                _ocr = PaddleOCR(
                    use_angle_cls=True,
                    lang=os.getenv("OCR_LANG", "fr"),
                    show_log=False,
                )
    return _ocr


def extract_lines(result):
    lines = []
    if not result:
        return lines

    pages = result if isinstance(result, list) else [result]
    for page in pages:
        if not page:
            continue
        for item in page:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            recognition = item[1]
            if not isinstance(recognition, (list, tuple)) or not recognition:
                continue
            text = str(recognition[0]).strip()
            confidence = float(recognition[1]) if len(recognition) > 1 else 0.0
            if text and confidence >= 0.60:
                lines.append({"text": text, "confidence": round(confidence, 4)})
    return lines


def prepare_variants(image):
    height, width = image.shape[:2]
    if width < 1400:
        scale = 1400 / max(width, 1)
        image = cv2.resize(
            image,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_CUBIC,
        )

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(enhanced, None, 7, 7, 21)
    return [image, cv2.cvtColor(denoised, cv2.COLOR_GRAY2BGR)]


def result_score(lines):
    useful_characters = sum(
        sum(character.isalnum() for character in line["text"]) for line in lines
    )
    confidence = sum(line["confidence"] for line in lines)
    return useful_characters + (confidence * 10)


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "engine": "PaddleOCR",
            "source": "nahlibee/OCR-rex",
            "modelLoaded": _ocr is not None,
        }
    )


@app.post("/ocr")
def recognize_document():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"ok": False, "message": "Aucun fichier recu."}), 400

    image_bytes = np.frombuffer(upload.read(), dtype=np.uint8)
    image = cv2.imdecode(image_bytes, cv2.IMREAD_COLOR)
    if image is None:
        return jsonify({"ok": False, "message": "Image invalide ou illisible."}), 400

    try:
        candidates = []
        for variant in prepare_variants(image):
            lines = extract_lines(get_ocr().ocr(variant, cls=True))
            candidates.append(lines)
        lines = max(candidates, key=result_score, default=[])
        raw_text = "\n".join(line["text"] for line in lines)
        useful_characters = sum(character.isalnum() for character in raw_text)
        if len(lines) < 2 or useful_characters < 12:
            return jsonify(
                {
                    "ok": False,
                    "message": "Aucun texte suffisamment fiable. Recadrez la CNI et evitez les reflets.",
                }
            ), 422
        return jsonify(
            {
                "ok": True,
                "engine": "PaddleOCR",
                "source": "nahlibee/OCR-rex",
                "rawText": raw_text,
                "lines": lines,
                "quality": {
                    "acceptedLines": len(lines),
                    "usefulCharacters": useful_characters,
                },
            }
        )
    except Exception as error:
        app.logger.exception("OCR-rex processing failed")
        return jsonify({"ok": False, "message": str(error)}), 500


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify({"ok": False, "message": "Image trop volumineuse (12 Mo maximum)."}), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
