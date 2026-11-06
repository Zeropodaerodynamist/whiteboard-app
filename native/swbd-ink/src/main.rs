//! Handwriting recognition sidecar for ZP Whiteboard.
//!
//! Reads one JSON request per line on stdin and writes one JSON response per line on
//! stdout. Recognition runs entirely on this machine through the Windows Ink analyzer
//! (Windows.UI.Input.Inking.Analysis); nothing leaves the computer.
//!
//! Request:  {"id": 1, "mode": "text" | "auto", "strokes": [[[x, y, pressure], ...], ...]}
//!           "text" treats every stroke as handwriting (the user asked for text);
//!           "auto" lets the analyzer tell writing from drawings (shapes).
//! Response: {"id": 1, "ok": true, "lines": [...], "words": [...], "drawings": [...]}
//!           {"id": 1, "ok": false, "error": "..."}
//! Stroke references in the response are indices into the request's `strokes`.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    strokes: Vec<Vec<[f32; 3]>>,
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    #[default]
    Text,
    Auto,
}

#[derive(Serialize, Default)]
struct Recognition {
    lines: Vec<Line>,
    words: Vec<Word>,
    drawings: Vec<Drawing>,
}

#[derive(Serialize)]
struct Line {
    text: String,
    rect: [f64; 4],
    strokes: Vec<usize>,
}

#[derive(Serialize)]
struct Word {
    text: String,
    alternates: Vec<String>,
    rect: [f64; 4],
    strokes: Vec<usize>,
}

#[derive(Serialize)]
struct Drawing {
    kind: &'static str,
    points: Vec<[f64; 2]>,
    rect: [f64; 4],
    strokes: Vec<usize>,
}

const MAX_STROKES: usize = 5_000;
const MAX_POINTS: usize = 200_000;

fn main() {
    #[cfg(windows)]
    unsafe {
        // The analyzer's async operations are joined by blocking, which needs the MTA.
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => {
                let id = req.id;
                match validate(&req).and_then(|_| analyze(&req.strokes, req.mode)) {
                    Ok(a) => serde_json::json!({ "id": id, "ok": true, "lines": a.lines, "words": a.words, "drawings": a.drawings }),
                    Err(e) => serde_json::json!({ "id": id, "ok": false, "error": e }),
                }
            }
            Err(e) => serde_json::json!({ "id": null, "ok": false, "error": format!("bad request: {e}") }),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

fn validate(req: &Request) -> Result<(), String> {
    if req.strokes.len() > MAX_STROKES {
        return Err(format!("too many strokes (max {MAX_STROKES})"));
    }
    let points: usize = req.strokes.iter().map(Vec::len).sum();
    if points > MAX_POINTS {
        return Err(format!("too many points (max {MAX_POINTS})"));
    }
    if req.strokes.iter().flatten().flatten().any(|v| !v.is_finite()) {
        return Err("coordinates must be finite numbers".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn analyze(_strokes: &[Vec<[f32; 3]>], _mode: Mode) -> Result<Recognition, String> {
    Err("handwriting recognition needs Windows".into())
}

#[cfg(windows)]
fn analyze(strokes: &[Vec<[f32; 3]>], mode: Mode) -> Result<Recognition, String> {
    win::analyze(strokes, mode).map_err(|e| format!("Windows Ink: {}", e.message()))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::collections::HashMap;
    use windows::core::{Interface, Result};
    use windows::Foundation::{Point, Rect};
    use windows::UI::Input::Inking::Analysis::*;
    use windows::UI::Input::Inking::*;
    use windows_collections::IIterable;
    use windows_numerics::Matrix3x2;

    fn rect(r: Rect) -> [f64; 4] {
        [r.X as f64, r.Y as f64, r.Width as f64, r.Height as f64]
    }

    fn drawing_kind(k: InkAnalysisDrawingKind) -> &'static str {
        match k {
            InkAnalysisDrawingKind::Circle => "circle",
            InkAnalysisDrawingKind::Ellipse => "ellipse",
            InkAnalysisDrawingKind::Triangle => "triangle",
            InkAnalysisDrawingKind::IsoscelesTriangle => "triangle",
            InkAnalysisDrawingKind::EquilateralTriangle => "triangle",
            InkAnalysisDrawingKind::RightTriangle => "triangle",
            InkAnalysisDrawingKind::Quadrilateral => "quadrilateral",
            InkAnalysisDrawingKind::Rectangle => "rectangle",
            InkAnalysisDrawingKind::Square => "square",
            InkAnalysisDrawingKind::Diamond => "diamond",
            InkAnalysisDrawingKind::Trapezoid => "trapezoid",
            InkAnalysisDrawingKind::Parallelogram => "parallelogram",
            InkAnalysisDrawingKind::Pentagon => "pentagon",
            InkAnalysisDrawingKind::Hexagon => "hexagon",
            _ => "drawing",
        }
    }

    pub fn analyze(strokes: &[Vec<[f32; 3]>], mode: Mode) -> Result<Recognition> {
        let builder = InkStrokeBuilder::new()?;
        let mut ink = Vec::with_capacity(strokes.len());
        let mut index_of: HashMap<u32, usize> = HashMap::new();
        for (i, s) in strokes.iter().enumerate() {
            if s.is_empty() {
                continue;
            }
            // A one-sample stroke (a dot) still needs two points to become an InkStroke.
            let mut samples = s.clone();
            if samples.len() == 1 {
                let p = samples[0];
                samples.push([p[0] + 0.01, p[1] + 0.01, p[2]]);
            }
            let pts: Vec<Option<InkPoint>> = samples
                .iter()
                .map(|p| InkPoint::CreateInkPoint(Point { X: p[0], Y: p[1] }, p[2].clamp(0.0, 1.0)).map(Some))
                .collect::<Result<_>>()?;
            let stroke = builder.CreateStrokeFromInkPoints(&IIterable::from(pts), Matrix3x2::identity())?;
            index_of.insert(stroke.Id()?, i);
            ink.push(Some(stroke));
        }
        let mut out = Recognition::default();
        if ink.is_empty() {
            return Ok(out);
        }
        let analyzer = InkAnalyzer::new()?;
        let ids: Vec<u32> = index_of.keys().copied().collect();
        analyzer.AddDataForStrokes(&IIterable::from(ink))?;
        if mode == Mode::Text {
            for id in ids {
                analyzer.SetStrokeDataKind(id, InkAnalysisStrokeKind::Writing)?;
            }
        }
        analyzer.AnalyzeAsync()?.join()?;
        let root = analyzer.AnalysisRoot()?;
        let ids = |n: &IInkAnalysisNode| -> Result<Vec<usize>> {
            Ok(n.GetStrokeIds()?.into_iter().filter_map(|id| index_of.get(&id).copied()).collect())
        };
        for n in root.FindNodes(InkAnalysisNodeKind::Line)? {
            let l: InkAnalysisLine = n.cast()?;
            out.lines.push(Line { text: l.RecognizedText()?.to_string(), rect: rect(n.BoundingRect()?), strokes: ids(&n)? });
        }
        for n in root.FindNodes(InkAnalysisNodeKind::InkWord)? {
            let w: InkAnalysisInkWord = n.cast()?;
            out.words.push(Word {
                text: w.RecognizedText()?.to_string(),
                alternates: w.TextAlternates()?.into_iter().map(|h| h.to_string()).collect(),
                rect: rect(n.BoundingRect()?),
                strokes: ids(&n)?,
            });
        }
        for n in root.FindNodes(InkAnalysisNodeKind::InkDrawing)? {
            let d: InkAnalysisInkDrawing = n.cast()?;
            out.drawings.push(Drawing {
                kind: drawing_kind(d.DrawingKind()?),
                points: d.Points()?.into_iter().map(|p| [p.X as f64, p.Y as f64]).collect(),
                rect: rect(n.BoundingRect()?),
                strokes: ids(&n)?,
            });
        }
        Ok(out)
    }
}
