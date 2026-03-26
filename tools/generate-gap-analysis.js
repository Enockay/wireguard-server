const path = require("path");
const fs = require("fs");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  LevelFormat,
  PageNumber,
  PageBreak,
  Header,
  Footer,
} = require("docx");

const BLUE = "1E3A5F";
const ACCENT = "2563EB";
const GREEN = "16A34A";
const ORANGE = "D97706";
const RED = "DC2626";
const GRAY = "6B7280";
const LIGHT_BLUE = "DBEAFE";
const LIGHT_GREEN = "DCFCE7";
const LIGHT_ORANGE = "FEF3C7";
const LIGHT_RED = "FEE2E2";
const WHITE = "FFFFFF";

const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, "../docs/gap-analysis.docx");

const border = { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: ACCENT, space: 6 } },
    children: [new TextRun({ text, font: "Arial", size: 32, bold: true, color: BLUE })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, font: "Arial", size: 26, bold: true, color: ACCENT })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: "Arial", size: 20, color: "374151", ...opts })],
  });
}

function bullet(text, color = null) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, font: "Arial", size: 20, color: color || "374151" })],
  });
}

function spacer(lines = 1) {
  return new Paragraph({ spacing: { before: lines * 80, after: 0 }, children: [new TextRun("")] });
}

function gapRow(num, endpoint, statusFill, statusText, gapFill, gap) {
  const numW = 600;
  const epW = 3600;
  const statusW = 1200;
  const gapW = 3960;

  return new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: numW, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [
          new Paragraph({
            children: [new TextRun({ text: String(num), font: "Arial", size: 18, color: GRAY })],
          }),
        ],
      }),
      new TableCell({
        borders,
        width: { size: epW, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [
          new Paragraph({
            children: [new TextRun({ text: endpoint, font: "Courier New", size: 17, color: "1D4ED8" })],
          }),
        ],
      }),
      new TableCell({
        borders,
        width: { size: statusW, type: WidthType.DXA },
        shading: { fill: statusFill, type: ShadingType.CLEAR },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: statusText, font: "Arial", size: 17, bold: true, color: WHITE })],
          }),
        ],
      }),
      new TableCell({
        borders,
        width: { size: gapW, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        shading: gapFill ? { fill: gapFill, type: ShadingType.CLEAR } : undefined,
        children: [new Paragraph({ children: [new TextRun({ text: gap, font: "Arial", size: 18 })] })],
      }),
    ],
  });
}

function tableHeader(labels, widths) {
  return new TableRow({
    tableHeader: true,
    children: labels.map(
      (label, index) =>
        new TableCell({
          borders,
          width: { size: widths[index], type: WidthType.DXA },
          shading: { fill: BLUE, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: label, font: "Arial", size: 19, bold: true, color: WHITE })],
            }),
          ],
        }),
    ),
  });
}

function promptBox(title, content) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders,
            shading: { fill: BLUE, type: ShadingType.CLEAR },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: `[Tool] ${title}`, font: "Arial", size: 20, bold: true, color: WHITE })],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            borders,
            shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: content,
          }),
        ],
      }),
    ],
  });
}

function codeBlock(text) {
  return new Paragraph({
    shading: { fill: "1E293B", type: ShadingType.CLEAR },
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Courier New", size: 18, color: "A5F3FC" })],
  });
}

function promptParagraph(text) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Arial", size: 19, color: "374151" })],
  });
}

function createDocument() {
  return new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 480, hanging: 240 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 20 } } },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 32, bold: true, font: "Arial" },
          paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 26, bold: true, font: "Arial" },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: ACCENT, space: 4 } },
                children: [
                  new TextRun({
                    text: "Mikrotik Admin Panel - Gap Analysis & Backend Implementation Guide",
                    font: "Arial",
                    size: 18,
                    color: GRAY,
                  }),
                  new TextRun({ text: "   |   Confidential", font: "Arial", size: 18, color: "9CA3AF" }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB", space: 4 } },
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Page ", font: "Arial", size: 17, color: GRAY }),
                  new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 17, color: GRAY }),
                ],
              }),
            ],
          }),
        },
        children: [
          spacer(4),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 160 },
            children: [new TextRun({ text: "MIKROTIK ADMIN PANEL", font: "Arial", size: 56, bold: true, color: BLUE })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 80 },
            children: [new TextRun({ text: "Gap Analysis & Backend Implementation Guide", font: "Arial", size: 30, color: ACCENT })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 8 } },
            spacing: { before: 0, after: 320 },
            children: [new TextRun({ text: "UI <-> Backend Alignment Report  |  March 2026", font: "Arial", size: 22, color: GRAY })],
          }),
          spacer(1),
          h1("1. Executive Summary"),
          body(
            "Both repositories have been cloned and fully analysed. The backend (wireguard-server on branch timoty-dev) and the React/TypeScript frontend (Mikrotik-admin) are architecturally well-aligned.",
          ),
          body("This document is organised as follows:", { bold: true }),
          bullet("Section 2 - Full gap table"),
          bullet("Section 3 - Priority 1 (critical blockers)"),
          bullet("Section 4 - Priority 2 (important but not blocking render)"),
          bullet("Section 5 - Ready-to-use implementation prompts"),
          h1("2. Complete Gap & Status Table"),
          body("The table below maps key UI endpoint calls against backend coverage."),
          new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: [600, 3600, 1200, 3960],
            rows: [
              tableHeader(["#", "UI Endpoint / Feature", "Status", "Gap Description"], [600, 3600, 1200, 3960]),
              new TableRow({
                children: [
                  new TableCell({
                    borders,
                    width: { size: 9360, type: WidthType.DXA },
                    columnSpan: 4,
                    shading: { fill: BLUE, type: ShadingType.CLEAR },
                    margins: { top: 60, bottom: 60, left: 120, right: 120 },
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: "ROUTER MANAGEMENT", font: "Arial", size: 19, bold: true, color: WHITE })],
                      }),
                    ],
                  }),
                ],
              }),
              gapRow(23, "GET /api/admin/routers/:id/topology/clusters", RED, "MISSING", null, "Route is not registered in topology.js."),
              gapRow(30, "GET /api/admin/routers/:id/backups/:backupId", RED, "MISSING", null, "Single-backup metadata route is absent."),
              gapRow(49, "PUT/DELETE /api/admin/routers/:routerId/pppoe/profiles/:profileId", RED, "MISSING", null, "Profile edit/delete handlers are missing."),
              gapRow(50, "PUT /api/admin/routers/:routerId/firewall/nat/:ruleId", RED, "MISSING", null, "NAT rule update endpoint is missing."),
              gapRow(51, "GET/DELETE /api/admin/routers/:routerId/hotspot/vouchers", RED, "MISSING", null, "Voucher listing and revoke endpoints are missing."),
            ],
          }),
          new Paragraph({ children: [new PageBreak()] }),
          h1("3. Priority 1 - Critical Blockers"),
          h2("GAP-2: Topology Clusters Endpoint Missing"),
          body("The NetworkTopologyViewer calls GET /api/admin/routers/:id/topology/clusters?zoom=N, but the backend route is never registered."),
          h2("GAP-3: Single Backup Detail Route Missing"),
          body("The UI declares GET /api/admin/routers/:id/backups/:backupId while the backend only exposes content and delete routes."),
          h2("GAP-4: PPPoE Profile Edit/Delete Routes Missing"),
          body("The backend has create support for PPPoE profiles but is missing edit and delete operations."),
          h2("GAP-5: Firewall NAT Rule Edit (PUT) Missing"),
          body("Backend has POST and DELETE for NAT rules but no update route."),
          h2("GAP-6: Hotspot Voucher List / Revoke Missing"),
          body("The backend can generate vouchers but not list or revoke them."),
          new Paragraph({ children: [new PageBreak()] }),
          h1("4. Ready-to-Use Implementation Prompts"),
          promptBox("PROMPT 2 - Register Topology Clusters Route", [
            promptParagraph("Add GET /api/admin/routers/:id/topology/clusters in wireguard-server/routes/topology.js."),
            codeBlock("app.get('/api/admin/routers/:id/topology/clusters', requireAdminPermission(...), async (req, res) => { ... });"),
          ]),
          spacer(1),
          promptBox("PROMPT 3 - Add Single Backup Detail Endpoint", [
            promptParagraph("Add GET /api/admin/routers/:routerId/backups/:backupId in wireguard-server/routes/backup.js."),
            codeBlock("const backup = await RouterBackup.findOne({ _id: req.params.backupId, routerId: req.params.routerId });"),
          ]),
          spacer(1),
          promptBox("PROMPT 4 - PPPoE Profile Edit & Delete Routes", [
            promptParagraph("Add PUT and DELETE handlers for /api/admin/routers/:routerId/pppoe/profiles/:profileId."),
          ]),
          spacer(1),
          promptBox("PROMPT 5 - Firewall NAT Rule Edit (PUT)", [
            promptParagraph("Add PUT /api/admin/routers/:routerId/firewall/nat/:ruleId and update the rule via RouterOS."),
          ]),
          spacer(1),
          promptBox("PROMPT 6 - Hotspot Voucher List & Revoke Endpoints", [
            promptParagraph("Add GET and DELETE handlers for router hotspot vouchers with pagination and revoke protection."),
          ]),
        ],
      },
    ],
  });
}

async function main() {
  const outputArg = process.argv[2];
  const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : DEFAULT_OUTPUT_PATH;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const doc = createDocument();
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`Gap analysis document written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
