# markitdown as the context-ingestion converter — evaluation (TASK-118)

**Verdict: adopt, for non-markdown document ingestion. Keep pdfminer for nothing.**

Context ingestion for non-markdown documents was ad hoc. The Karpathy PDF was converted with a
one-off pdfminer script (`group-e-token-memory-graph`), not through a reusable converter, so every
new document format would have needed its own bespoke script.

## What was run

A real, bounded comparison — not a reading of the README. `markitdown` 0.1.7 against `pdfminer.six`
20260107, on this machine, 2026-09-13.

**Corpus.** "Attention Is All You Need" (arXiv 1706.03762, 2.2 MB, 15 pages) — a genuinely
representative technical PDF: two-column layout, a vertical arXiv stamp down the left margin, dense
result tables, math. Plus a `.docx` (heading, paragraph, 2×2 table) and a `.pptx` (title +
bullet), because "does it handle the formats we've actually needed" is half the question.

The PDFs already on this machine are the operator's personal documents. They were deliberately not
used; a public paper answers the same question without reading anything private.

## Results

| | pdfminer | markitdown |
| --- | --- | --- |
| PDF conversion | 2.4 s | 3.8 s |
| Output size | 39,830 bytes | 40,329 bytes |
| Markdown tables emitted | **0** | **72 rows** |
| Single-character noise lines | 58 | 54 |
| `.docx` | **fails** (`PDFSyntaxError`) | converts, with the table |
| `.pptx` | **fails** (`PDFSyntaxError`) | converts, with slide markers |

### The difference that decides it: tables

pdfminer flattens a results table into a column of orphaned cell labels. The row/column
relationship — which is the entire content of a results table — is destroyed:

```
Layer Type

Complexity per Layer

Self-Attention
Recurrent
Convolutional
```

markitdown reconstructs it as a markdown table a model can actually read:

```
|                     | EN-DE | EN-FR | EN-DE    | EN-FR    |
| ------------------- | ----- | ----- | -------- | -------- |
| ByteNet[18]         | 23.75 |       |          |          |
| GNMT+RL[38]         | 24.6  | 39.92 |          |          |
```

Column alignment is imperfect on the multi-header tables (a header row occasionally lands outside
its own table), so this is "readable and structurally correct", not "pixel-perfect". That is still
categorically better than losing the structure.

### The difference that is smaller than advertised: prose

Both tools produce the same intra-word space loss on this document
(`Thedominantsequencetransductionmodels`). That is the PDF's own font kerning, not a converter
defect, and neither tool fixes it. Anyone expecting markitdown to clean up a badly-kerned PDF will
be disappointed — the gain is structure, not text quality.

markitdown does skip the vertical arXiv stamp that pdfminer emits as ~20 single-character lines at
the top of the output. Marginal, but it is the first thing a reader sees.

### The difference that ends the argument: format coverage

pdfminer is a PDF library. Handed a `.docx` or `.pptx` it raises `PDFSyntaxError: No /Root object!`
— as it should. Every non-PDF format would need a separate library and a separate script, which is
precisely the ad-hoc-per-format problem this task exists to remove.

## Decision

**Adopt markitdown as the standard context-ingestion converter.** One dependency replaces
per-format scripts, it is maintained by Microsoft, and it is a converter rather than a store — so
there is no invariant conflict with ADR-002, ADR-008 or ADR-009.

**Cost accepted:** ~60% slower on a 15-page PDF (1.4 s absolute). Ingestion is not on any hot path;
it happens once per document.

**Install as `markitdown[pdf,docx,pptx,xlsx]`.** The bare package installs no format handlers, and
a bare install silently converts nothing useful.

**Not adopted:** markitdown's LLM-backed image captioning. It requires a model call per image, and
image description is not a gap we have.

## Reproducing this

```bash
python3 -m venv venv && ./venv/bin/pip install "markitdown[pdf,docx,pptx,xlsx]"
curl -sL -o attention.pdf https://arxiv.org/pdf/1706.03762
./venv/bin/python -c "
from markitdown import MarkItDown
print(MarkItDown().convert('attention.pdf').text_content)"
```
