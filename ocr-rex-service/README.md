# OCR-rex service for the rental dashboard

This local service adapts the PaddleOCR engine and workflow from
[nahlibee/OCR-rex](https://github.com/nahlibee/OCR-rex). The original repository
cannot be connected directly because it contains author-specific Windows paths
and stores results in its own SQLite database.

## First installation

1. Install 64-bit Python 3.10 or 3.11 if it is not already installed.
2. Double-click `install.bat` once. PaddleOCR is large, so installation can take
   several minutes.
3. Double-click `start.bat` before opening the rental dashboard.
4. Keep the OCR window open while scanning a client document.

The first scan can take longer because PaddleOCR may download its French model.
The dashboard calls `http://127.0.0.1:5000/ocr`. It does not report a successful
scan unless OCR-rex returns enough high-confidence text. Manual client entry
remains available when the service is offline or a document is unreadable.
