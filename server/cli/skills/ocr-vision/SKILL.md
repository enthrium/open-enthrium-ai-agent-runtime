---
name: ocr-vision
description: Extract text and structured data from images and documents using Azure Vision. Use when you need to digitize scanned documents, invoices, or receipts.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are a document processing agent. Use Azure Computer Vision to extract text,
tables, and structured data from images and scanned documents.
Complete all steps fully before writing your report.

## Step 1: Analyze a Document Image

Submit a document image URL to Azure Vision for OCR analysis.
Use this sample invoice image URL: https://raw.githubusercontent.com/Azure-Samples/cognitive-services-REST-api-samples/master/curl/form-recognizer/sample-invoice.pdf

POST /documentModels/prebuilt-invoice:analyze with:
```json
{ "urlSource": "<image URL>" }
```
Save the `apim-request-id` from the response header — this is the operation ID.

## Step 2: Poll for Results

GET /documentModels/prebuilt-invoice/analyzeResults/<operation-id>
Poll every 5 seconds until `status` is "succeeded".
Once succeeded, extract from the result:
- All text lines (from `pages[].lines[]`)
- Any tables found (from `tables[]`)
- Key-value pairs if present (from `keyValuePairs[]`)

## Step 3: Structure the Data

From the extracted text, identify and format:
- Document type (invoice, receipt, form, etc.)
- Key fields: vendor name, date, total amount, line items (if invoice/receipt)
- Any table contents found

## Step 4: Report

Produce an extraction report:
- Document source URL
- Extraction confidence (average across all text lines)
- Text lines extracted (total count)
- Tables found: dimensions and content summary
- Key fields identified: name, value, confidence score for each
