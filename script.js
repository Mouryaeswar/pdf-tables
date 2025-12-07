document.addEventListener("DOMContentLoaded", () => {
  // Configure pdf.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

  const fileInput = document.getElementById("pdfFile");
  const generateBtn = document.getElementById("generateBtn");
  const openNewPageBtn = document.getElementById("openNewPageBtn");
  const statusEl = document.getElementById("status");
  const tablesContainer = document.getElementById("tablesContainer");

  let currentFileArrayBuffer = null;
  let lastExtractedTables = null; // for "Open in New Page"

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) {
      currentFileArrayBuffer = null;
      statusEl.textContent = "No file selected.";
      return;
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
      currentFileArrayBuffer = evt.target.result;
      statusEl.textContent = `Loaded file: ${file.name}. Now click "Generate Tables".`;
      openNewPageBtn.disabled = true;
      lastExtractedTables = null;
      tablesContainer.innerHTML = "";
    };
    reader.readAsArrayBuffer(file);
  });

  generateBtn.addEventListener("click", async () => {
    if (!currentFileArrayBuffer) {
      statusEl.textContent = "Please choose a PDF file first.";
      return;
    }

    generateBtn.disabled = true;
    openNewPageBtn.disabled = true;
    statusEl.textContent = "Processing PDF (text + OCR if needed)...";

    try {
      const tables = await extractTablesFromPDF(currentFileArrayBuffer);

      if (!tables || tables.length === 0) {
        tablesContainer.innerHTML =
          '<p class="no-tables">No tables detected.</p>';
        statusEl.textContent = "Done. No clear tables were found.";
        lastExtractedTables = null;
        openNewPageBtn.disabled = true;
      } else {
        lastExtractedTables = tables;
        renderTables(tables);
        statusEl.textContent = `Done. Detected ${tables.length} table(s).`;
        openNewPageBtn.disabled = false;
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Error processing PDF. Check console for details.";
      lastExtractedTables = null;
      openNewPageBtn.disabled = true;
    } finally {
      generateBtn.disabled = false;
    }
  });

  // When user clicks "Open in New Page"
  openNewPageBtn.addEventListener("click", () => {
    if (!lastExtractedTables || lastExtractedTables.length === 0) {
      alert("No tables extracted yet!");
      return;
    }
    openTablesInNewPage(lastExtractedTables);
  });

  /**
   * Open the tables in a brand-new page / tab.
   */
  function openTablesInNewPage(tables) {
    const newWin = window.open("", "_blank");
    if (!newWin) {
      alert("Popup blocked! Please allow popups for this site.");
      return;
    }

    let html = `
      <html>
        <head>
          <title>Extracted Tables</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
            h2 { margin-bottom: 20px; }
            .table-wrapper {
              margin-bottom: 24px;
              padding: 12px;
              background: #ffffff;
              border-radius: 8px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.08);
              overflow-x: auto;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin-top: 10px;
            }
            th, td {
              border: 1px solid #ccc;
              padding: 6px 10px;
              text-align: left;
              white-space: nowrap;
              font-size: 14px;
            }
            th {
              background: #e3f2fd;
              font-weight: bold;
            }
            tr:nth-child(even) td {
              background: #f9f9f9;
            }
          </style>
        </head>
        <body>
          <h2>Extracted Tables</h2>
    `;

    tables.forEach((tableData, index) => {
      html += `<div class="table-wrapper"><h3>Table ${index + 1}</h3><table>`;
      tableData.forEach((row, rIndex) => {
        html += "<tr>";
        row.forEach((cell) => {
          html += rIndex === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`;
        });
        html += "</tr>";
      });
      html += "</table></div>";
    });

    html += "</body></html>";

    newWin.document.write(html);
    newWin.document.close();
  }

  /**
   * Extract tables from PDF array buffer.
   * - Text pages: generic detection.
   * - Scanned pages: OCR + special ISRO internship-table detection.
   */
  async function extractTablesFromPDF(arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const allTables = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      statusEl.textContent = `Processing page ${pageNum}/${pdf.numPages}...`;

      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // 1) TEXT-BASED PAGE
      if (textContent.items && textContent.items.length > 0) {
        const lines = groupTextItemsIntoLines(textContent.items);
        const pageTables = detectTablesFromLines(lines);
        allTables.push(...pageTables);
        continue;
      }

      // 2) SCANNED PAGE: OCR
      console.log("No text layer; running OCR on page", pageNum);
      const ocrText = await runOCROnPage(page);

      const specialTable = detectIsroInternshipTable(ocrText);
      if (specialTable) {
        allTables.push(specialTable);
      }
    }

    return allTables;
  }

  /**
   * OCR helper: render page to canvas and run Tesseract.
   */
  async function runOCROnPage(page) {
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const result = await Tesseract.recognize(canvas, "eng", {
      logger: (m) => console.log(m),
    });
    return result.data.text || "";
  }

  /**
   * SPECIAL CASE: detect the internship table in OCR text.
   */
  function detectIsroInternshipTable(ocrText) {
    if (!ocrText || !ocrText.trim()) return null;

    const flat = ocrText.replace(/\s+/g, " ");

    const rowRegex =
      /(\d+)\s+([A-Za-z][A-Za-z .]+?)\s+([0-9A-Z]{8,})\s+(\d{2}\/\d{2}\/\d{4})\s*(?:to|-)\s*(\d{2}\/\d{2}\/\d{4})/;

    const m = flat.match(rowRegex);
    if (!m) return null;

    const sNo = m[1].trim();
    const name = m[2].trim();
    const roll = m[3].trim();
    const period = `${m[4].trim()} to ${m[5].trim()}`;

    const headerRow = [
      "S.No.",
      "Name of the Student (Mr./Ms.)",
      "College Roll No.",
      "Permitted period of the Internship Training",
    ];

    const dataRow = [sNo, name, roll, period];

    return [headerRow, dataRow];
  }

  /**
   * Generic text-based table detection.
   */
  function groupTextItemsIntoLines(items) {
    const linesMap = {};

    items.forEach((item) => {
      const t = item.transform;
      const x = t[4];
      const y = t[5];
      const key = Math.round(y);

      if (!linesMap[key]) {
        linesMap[key] = [];
      }
      linesMap[key].push({ x, text: item.str || "" });
    });

    const sortedY = Object.keys(linesMap)
      .map(Number)
      .sort((a, b) => b - a);

    const lines = sortedY.map((y) => {
      const parts = linesMap[y].sort((a, b) => a.x - b.x);
      const lineText = parts
        .map((p) => p.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
      return lineText;
    });

    return lines.filter((line) => line.trim().length > 0);
  }

  function detectTablesFromLines(lines) {
    const tables = [];

    const tokenLines = lines.map((line) => ({
      text: line,
      tokens: line.trim().split(/\s+/).filter(Boolean),
    }));

    const isNumericFirstToken = (tokens) => {
      if (!tokens || tokens.length === 0) return false;
      const first = tokens[0];
      return /^\d+\.?$/.test(first);
    };

    const n = tokenLines.length;

    for (let i = 0; i < n; i++) {
      const headerTokens = tokenLines[i].tokens;
      if (!headerTokens || headerTokens.length < 2) continue;

      const headerLen = headerTokens.length;
      const rowsTokens = [headerTokens];

      let j = i + 1;
      while (j < n) {
        const rowTokens = tokenLines[j].tokens;
        if (!rowTokens || rowTokens.length < 2) break;

        const sameLen = rowTokens.length === headerLen;
        const numericFirst = isNumericFirstToken(rowTokens);

        if (sameLen || numericFirst) {
          rowsTokens.push(rowTokens);
          j++;
        } else {
          break;
        }
      }

      if (rowsTokens.length >= 3) {
        const table = buildNormalizedTable(rowsTokens);
        tables.push(table);
        i = j - 1;
      }
    }

    return tables;
  }

  function buildNormalizedTable(rowsTokens) {
    const headerTokens = rowsTokens[0];
    const dataRowsTokens = rowsTokens.slice(1);

    const headerCells = normalizeHeaderTokens(headerTokens);
    const colCount = headerCells.length;

    const table = [];
    table.push(headerCells);

    dataRowsTokens.forEach((tokens) => {
      table.push(normalizeDataRow(tokens, colCount));
    });

    return table;
  }

  function normalizeHeaderTokens(tokens) {
    const res = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (res.length <= 2) {
        res.push(t);
      } else {
        if (t.length <= 2) {
          res[res.length - 1] = res[res.length - 1] + " " + t;
        } else {
          res.push(t);
        }
      }
    }
    return res;
  }

  function normalizeDataRow(tokens, colCount) {
    if (!tokens) return new Array(colCount).fill("");

    if (tokens.length === colCount) return tokens.slice();

    if (tokens.length < colCount) {
      const row = tokens.slice();
      while (row.length < colCount) row.push("");
      return row;
    }

    const row = [];
    row.push(tokens[0]);

    let remainingTokens = tokens.slice(1);
    const remainingCols = colCount - 1;

    if (remainingCols <= 1) {
      row.push(remainingTokens.join(" "));
      return row;
    }

    const tailColsCount = remainingCols - 1;
    const tailTokens = [];
    for (let k = 0; k < tailColsCount && remainingTokens.length > 0; k++) {
      tailTokens.unshift(remainingTokens.pop());
    }

    const secondCol = remainingTokens.join(" ");
    row.push(secondCol);
    tailTokens.forEach((tok) => row.push(tok));

    while (row.length < colCount) row.push("");
    if (row.length > colCount) row.length = colCount;

    return row;
  }

  function renderTables(tables) {
    tablesContainer.innerHTML = "";

    tables.forEach((tableData, tableIndex) => {
      const wrapper = document.createElement("div");
      wrapper.className = "table-wrapper";

      const title = document.createElement("h3");
      title.textContent = `Table ${tableIndex + 1}`;
      wrapper.appendChild(title);

      const table = document.createElement("table");
      table.className = "pdf-table";

      tableData.forEach((rowData, rowIndex) => {
        const tr = document.createElement("tr");
        rowData.forEach((cellData) => {
          const cell = document.createElement(rowIndex === 0 ? "th" : "td");
          cell.textContent = cellData;
          tr.appendChild(cell);
        });
        table.appendChild(tr);
      });

      wrapper.appendChild(table);
      tablesContainer.appendChild(wrapper);
    });
  }
});
