import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ─────────────────────────────────────────────────────────────
// 調剤ベースアップ評価料 管理ツール
//
// 仕組み（令和8年度診療報酬改定）:
//   調剤ベースアップ評価料 = 処方箋の受付1回につき 4点
//     ・令和9年6月（2027-06）以降は所定点数の200% = 8点
//   1点 = 10円。よって  収入 = 受付回数 × 点数 × 10
//   この収入は対象職員のベースアップ（基本給等の引上げ＋連動分）に充てる。
//
// 賃金改善の充当額 = Σ(職員の月額ベア額) × 係数(既定1.29)
//   1.29 = 基本給等の引上げに伴う 法定福利費(事業主負担) と 連動する賞与 を見込んだ係数。
//   ※実績報告では実額（①基本給等の引上げ＋⑤連動増加分）を用いる。本ツールは概算管理用。
//
//   受付回数が未入力(0/空)の月は「未入力」とみなし、累計・グラフ・充当率の集計から
//   除外する（まだ算定していない先の月が充当率を過大に見せないようにするため）。
// ─────────────────────────────────────────────────────────────

const YEN_PER_POINT = 10;
const DOUBLE_FROM = "2027-06"; // この月以降は点数2倍（4点→8点）
const POINT_BASE = 4;

const STORAGE_KEY = "baseup-hyokaryo-v1";

// 点数（月単位）: 2027-06 以降は 8点
function pointsForMonth(ym) {
  return ym >= DOUBLE_FROM ? POINT_BASE * 2 : POINT_BASE;
}

// 年度区分（算定期間ベース）: R8 = 2026-06〜2027-05 / R9 = 2027-06〜2028-05 ...
function fiscalLabel(ym) {
  return ym >= DOUBLE_FROM ? "令和9年度" : "令和8年度";
}

// "2026-06" → "26/6"（グラフ用の短縮表記）
function shortYm(ym) {
  const [y, m] = ym.split("-");
  return `${y.slice(2)}/${Number(m)}`;
}

const yen = (n) => Math.round(n).toLocaleString("ja-JP");

// ファイルをダウンロードさせる
function download(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 今日の日付（YYYYMMDD）
function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ── 初期データ（ダミーのサンプル値。実数値に置き換えてください）──────────
// ※ 公開リポジトリにも載るため、実在の数値ではなく分かりやすい仮の値にしている。
const SAMPLE_RECEIPTS = [
  1400, 1450, 1500, 1450, 1400, 1450, 1500, 1450, 1400, 1450, 1500, 1450,
];
function buildDefaultMonths() {
  // 令和8年度の算定期間 2026-06 〜 2027-05（12か月）
  const out = [];
  let y = 2026,
    m = 6;
  for (let i = 0; i < 12; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ ym, receipts: SAMPLE_RECEIPTS[i] ?? 0 });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const DEFAULT_STAFF = [
  { id: 1, name: "薬剤師A", role: "薬剤師", baseUp: 16000, startYm: "2026-06" },
  { id: 2, name: "薬剤師B", role: "薬剤師", baseUp: 15000, startYm: "2026-06" },
  { id: 3, name: "事務A", role: "事務職員", baseUp: 16000, startYm: "2026-06" },
];

function loadSaved() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return null;
    const o = JSON.parse(s);
    if (o && Array.isArray(o.months) && Array.isArray(o.staff)) return o;
    return null;
  } catch {
    return null;
  }
}

// 次の月（"2026-06" → "2026-07"）
function nextYm(ym) {
  let [y, m] = ym.split("-").map(Number);
  m++;
  if (m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

const ROLES = ["薬剤師", "事務職員", "その他"];

export default function App() {
  const saved = loadSaved();
  const [months, setMonths] = useState(saved?.months ?? buildDefaultMonths());
  const [staff, setStaff] = useState(saved?.staff ?? DEFAULT_STAFF);
  const [factor, setFactor] = useState(saved?.factor ?? 1.29);
  const fileRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ months, staff, factor })
    );
  }, [months, staff, factor]);

  // ── 月次の集計 ──────────────────────────────────────────
  // entered=false（受付回数未入力）の月は集計に含めない。
  const rows = useMemo(() => {
    let cumIncome = 0;
    let cumImprove = 0;
    return months.map((mo) => {
      const entered = (Number(mo.receipts) || 0) > 0;
      const pts = pointsForMonth(mo.ym);
      const income = entered ? mo.receipts * pts * YEN_PER_POINT : 0;
      // その月に有効な職員のベア合計 × 係数
      const baseUpSum = staff
        .filter((s) => (s.startYm || "0000-00") <= mo.ym)
        .reduce((a, s) => a + (Number(s.baseUp) || 0), 0);
      const improve = entered ? baseUpSum * factor : 0;
      if (entered) {
        cumIncome += income;
        cumImprove += improve;
      }
      return {
        ...mo,
        entered,
        pts,
        income,
        improve,
        diff: improve - income,
        cumIncome,
        cumImprove,
        cumDiff: cumImprove - cumIncome,
      };
    });
  }, [months, staff, factor]);

  const enteredRows = useMemo(() => rows.filter((r) => r.entered), [rows]);

  const totals = useMemo(() => {
    const income = enteredRows.reduce((a, r) => a + r.income, 0);
    const improve = enteredRows.reduce((a, r) => a + r.improve, 0);
    const rate = income > 0 ? (improve / income) * 100 : 0;
    return {
      income,
      improve,
      diff: improve - income,
      rate,
      ok: improve >= income,
      count: enteredRows.length,
    };
  }, [enteredRows]);

  // ── 年度サマリー ────────────────────────────────────────
  const byFiscal = useMemo(() => {
    const map = new Map();
    enteredRows.forEach((r) => {
      const k = fiscalLabel(r.ym);
      const g = map.get(k) ?? { fiscal: k, receipts: 0, income: 0, improve: 0 };
      g.receipts += r.receipts || 0;
      g.income += r.income;
      g.improve += r.improve;
      map.set(k, g);
    });
    return [...map.values()];
  }, [enteredRows]);

  const chartData = useMemo(
    () =>
      enteredRows.map((r) => ({
        name: shortYm(r.ym),
        収入: Math.round(r.income),
        賃金改善: Math.round(r.improve),
        累計差額: Math.round(r.cumDiff),
      })),
    [enteredRows]
  );

  // ── 編集ハンドラ ────────────────────────────────────────
  const setReceipts = (i, v) =>
    setMonths((m) =>
      m.map((row, idx) =>
        idx === i ? { ...row, receipts: v === "" ? 0 : Number(v) } : row
      )
    );
  const addMonth = () =>
    setMonths((m) => [
      ...m,
      { ym: m.length ? nextYm(m[m.length - 1].ym) : "2026-06", receipts: 0 },
    ]);
  const removeMonth = () =>
    setMonths((m) => (m.length > 1 ? m.slice(0, -1) : m));

  const updStaff = (id, key, v) =>
    setStaff((s) => s.map((x) => (x.id === id ? { ...x, [key]: v } : x)));
  const addStaff = () =>
    setStaff((s) => [
      ...s,
      {
        id: (s.reduce((a, x) => Math.max(a, x.id), 0) || 0) + 1,
        name: "",
        role: "薬剤師",
        baseUp: 0,
        startYm: months[0]?.ym ?? "2026-06",
      },
    ]);
  const delStaff = (id) => setStaff((s) => s.filter((x) => x.id !== id));

  const resetAll = () => {
    if (!window.confirm("入力内容を初期サンプルに戻します。よろしいですか？")) return;
    setMonths(buildDefaultMonths());
    setStaff(DEFAULT_STAFF);
    setFactor(1.29);
  };

  // ── データ入出力 ────────────────────────────────────────
  const exportJson = () =>
    download(
      `ベースアップ管理_バックアップ_${today()}.json`,
      JSON.stringify({ version: 1, months, staff, factor }, null, 2),
      "application/json;charset=utf-8"
    );

  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const o = JSON.parse(reader.result);
        if (!Array.isArray(o.months) || !Array.isArray(o.staff))
          throw new Error("形式が不正です");
        setMonths(o.months);
        setStaff(o.staff);
        if (typeof o.factor === "number") setFactor(o.factor);
        window.alert("バックアップを復元しました。");
      } catch (e) {
        window.alert("復元に失敗しました：" + e.message);
      }
    };
    reader.readAsText(file);
  };

  const exportCsv = () => {
    const head = [
      "算定月",
      "処方箋受付回数",
      "点数",
      "評価料収入(円)",
      "賃金改善(円)",
      "当月差額(円)",
      "累計差額(円)",
      "状態",
    ];
    const lines = rows.map((r) =>
      [
        r.ym,
        r.entered ? r.receipts : "",
        r.pts,
        r.entered ? Math.round(r.income) : "",
        r.entered ? Math.round(r.improve) : "",
        r.entered ? Math.round(r.diff) : "",
        r.entered ? Math.round(r.cumDiff) : "",
        r.entered ? "入力済" : "未入力",
      ].join(",")
    );
    // Excel で文字化けしないよう UTF-8 BOM を付与
    const csv = "﻿" + [head.join(","), ...lines].join("\r\n");
    download(`ベースアップ管理_月次明細_${today()}.csv`, csv, "text/csv;charset=utf-8");
  };

  const nowPoints = pointsForMonth(
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`
  );

  return (
    <div className="wrap">
      <header className="app-head">
        <h1>調剤ベースアップ評価料 管理</h1>
        <p>
          算定で得た収入（処方箋受付 × 点数 × 10円）と、職員の賃金改善額を突き合わせ、
          充当不足がないかを管理します。
        </p>
      </header>

      {/* ── ステータス ── */}
      <div className="stats" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="label">累計 評価料収入</div>
          <div className="value">
            {yen(totals.income)}
            <small> 円</small>
          </div>
        </div>
        <div className="stat">
          <div className="label">累計 賃金改善額（充当）</div>
          <div className="value">
            {yen(totals.improve)}
            <small> 円</small>
          </div>
        </div>
        <div className="stat">
          <div className="label">充当率（改善 ÷ 収入）</div>
          <div className="value">
            {totals.rate.toFixed(1)}
            <small> %</small>
          </div>
        </div>
        <div className="stat">
          <div className="label">判定（入力済 {totals.count} か月）</div>
          <div style={{ marginTop: 4 }}>
            <span className={`badge ${totals.ok ? "ok" : "warn"}`}>
              {totals.ok ? "適合（充当OK）" : "要改善（賃金改善が不足）"}
            </span>
            <div className="note" style={{ marginTop: 6 }}>
              {totals.ok
                ? `余裕 ${yen(totals.diff)} 円`
                : `不足 ${yen(-totals.diff)} 円`}
            </div>
          </div>
        </div>
      </div>

      {/* ── グラフ ── */}
      <section className="card">
        <h2>
          <span className="num">1</span>月次推移（収入 vs 賃金改善・累計差額）
        </h2>
        {chartData.length === 0 ? (
          <p className="note">受付回数を入力すると、月次の推移グラフが表示されます。</p>
        ) : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <ComposedChart
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
              >
                <CartesianGrid stroke="#eaf2ef" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  formatter={(v) => `${yen(v)} 円`}
                  labelStyle={{ color: "#0a5e5d" }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="収入" fill="#0e7c7b" radius={[3, 3, 0, 0]} />
                <Bar dataKey="賃金改善" fill="#9bd3c6" radius={[3, 3, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="累計差額"
                  stroke="#db5424"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="note">
          棒：各月の収入と賃金改善額。折れ線：累計の差額（賃金改善−収入）。
          累計差額がマイナスに沈むと充当不足です。
        </p>
      </section>

      {/* ── 月次明細 ── */}
      <section className="card">
        <h2>
          <span className="num">2</span>月次明細（受付回数を入力）
        </h2>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>算定月</th>
                <th>処方箋受付回数</th>
                <th>点数</th>
                <th>評価料収入(円)</th>
                <th>賃金改善(円)</th>
                <th>当月差額</th>
                <th>累計差額</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.ym}
                  className={
                    !r.entered ? "pending" : r.cumDiff < 0 ? "short" : ""
                  }
                >
                  <td>{r.ym}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      aria-label={`${r.ym} の処方箋受付回数`}
                      placeholder="未入力"
                      value={r.receipts || ""}
                      onChange={(e) => setReceipts(i, e.target.value)}
                    />
                  </td>
                  <td>{r.pts}点</td>
                  <td>{r.entered ? yen(r.income) : "—"}</td>
                  <td>{r.entered ? yen(r.improve) : "—"}</td>
                  <td
                    style={{
                      color: !r.entered
                        ? "#9aa8a8"
                        : r.diff < 0
                        ? "#b4341f"
                        : "#137a4b",
                    }}
                  >
                    {!r.entered
                      ? "—"
                      : `${r.diff >= 0 ? "+" : ""}${yen(r.diff)}`}
                  </td>
                  <td
                    style={{
                      color: !r.entered
                        ? "#9aa8a8"
                        : r.cumDiff < 0
                        ? "#b4341f"
                        : "#137a4b",
                    }}
                  >
                    {!r.entered
                      ? "—"
                      : `${r.cumDiff >= 0 ? "+" : ""}${yen(r.cumDiff)}`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>合計（入力済）</td>
                <td>
                  {yen(enteredRows.reduce((a, r) => a + (r.receipts || 0), 0))}
                </td>
                <td>—</td>
                <td>{yen(totals.income)}</td>
                <td>{yen(totals.improve)}</td>
                <td colSpan={2}>
                  {totals.ok ? "+" : ""}
                  {yen(totals.diff)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row-actions">
          <button className="btn" onClick={addMonth}>
            ＋ 次の月を追加
          </button>
          <button className="btn ghost" onClick={removeMonth}>
            最終月を削除
          </button>
        </div>
        <p className="note">
          点数は 2026-06〜2027-05 が <b>4点</b>、2027-06（令和9年6月）以降は{" "}
          <b>8点</b>（200%）に自動切替（1点＝10円）。受付回数が空の月は「未入力」として集計から除外します。
        </p>
      </section>

      {/* ── 職員（賃金改善） ── */}
      <section className="card">
        <h2>
          <span className="num">3</span>対象職員の賃上げ（月額ベア額）
        </h2>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>氏名</th>
                <th>職種</th>
                <th>月額ベア額(円)</th>
                <th>適用開始月</th>
                <th>充当/月(×{factor})</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input
                      type="text"
                      value={s.name}
                      placeholder="氏名"
                      aria-label="職員の氏名"
                      onChange={(e) => updStaff(s.id, "name", e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      value={s.role}
                      aria-label="職種"
                      onChange={(e) => updStaff(s.id, "role", e.target.value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      aria-label="月額ベア額"
                      value={s.baseUp}
                      onChange={(e) =>
                        updStaff(s.id, "baseUp", Number(e.target.value) || 0)
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="month"
                      aria-label="適用開始月"
                      value={s.startYm}
                      onChange={(e) =>
                        updStaff(s.id, "startYm", e.target.value)
                      }
                    />
                  </td>
                  <td>{yen((Number(s.baseUp) || 0) * factor)}</td>
                  <td>
                    <button className="btn del" onClick={() => delStaff(s.id)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>合計</td>
                <td>{yen(staff.reduce((a, s) => a + (Number(s.baseUp) || 0), 0))}</td>
                <td>—</td>
                <td>
                  {yen(
                    staff.reduce((a, s) => a + (Number(s.baseUp) || 0), 0) * factor
                  )}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row-actions">
          <button className="btn" onClick={addStaff}>
            ＋ 職員を追加
          </button>
          <label className="field-row" style={{ marginLeft: "auto" }}>
            係数（法定福利費・連動賞与込み）
            <input
              type="number"
              step="0.01"
              min="1"
              aria-label="係数"
              value={factor}
              onChange={(e) => setFactor(Number(e.target.value) || 1)}
            />
          </label>
        </div>
        <p className="note">
          「月額ベア額」は基本給等の引上げ分（月額）。これに係数{factor}
          （事業主負担の法定福利費＋連動する賞与の見込み）を掛けた額を賃金改善の充当額とみなします。
          実績報告では実額をご確認ください。
        </p>
      </section>

      {/* ── 年度サマリー ── */}
      <section className="card">
        <h2>
          <span className="num">4</span>年度サマリー（実績報告の目安）
        </h2>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>算定年度</th>
                <th>受付回数 計</th>
                <th>評価料収入 計(円)</th>
                <th>賃金改善 計(円)</th>
                <th>差額(改善−収入)</th>
                <th>充当率</th>
              </tr>
            </thead>
            <tbody>
              {byFiscal.length === 0 ? (
                <tr className="pending">
                  <td colSpan={6} style={{ textAlign: "center" }}>
                    受付回数を入力すると集計されます
                  </td>
                </tr>
              ) : (
                byFiscal.map((g) => {
                  const diff = g.improve - g.income;
                  const rate = g.income > 0 ? (g.improve / g.income) * 100 : 0;
                  return (
                    <tr key={g.fiscal} className={diff < 0 ? "short" : ""}>
                      <td>{g.fiscal}</td>
                      <td>{yen(g.receipts)}</td>
                      <td>{yen(g.income)}</td>
                      <td>{yen(g.improve)}</td>
                      <td style={{ color: diff < 0 ? "#b4341f" : "#137a4b" }}>
                        {diff >= 0 ? "+" : ""}
                        {yen(diff)}
                      </td>
                      <td>{rate.toFixed(1)}%</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          賃金改善実績報告書は毎年8月に提出します。評価料収入は全額を賃金改善に充てる必要があるため、
          差額がプラス（改善 ≧ 収入）になっているか各年度で確認してください。
        </p>
      </section>

      {/* ── データ管理 ── */}
      <section className="card">
        <h2>
          <span className="num">5</span>データ管理
        </h2>
        <div className="row-actions">
          <button className="btn" onClick={exportCsv}>
            月次明細をCSV出力
          </button>
          <button className="btn" onClick={exportJson}>
            バックアップ保存(JSON)
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            バックアップ復元
          </button>
          <button className="btn ghost" onClick={resetAll}>
            サンプルに戻す
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.[0]) importJson(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </div>
        <p className="note">
          入力データはこのブラウザ内（localStorage）にのみ保存されます。
          PC・ブラウザの変更やデータ消去に備え、ときどき「バックアップ保存」でファイルに残してください。
          現在の単価＝1点{YEN_PER_POINT}円／今月の点数＝{nowPoints}点。
        </p>
      </section>

      <p className="note">
        ※ 本ツールは概算管理用です。点数・算定要件・報告様式の正式な内容は
        厚生労働省の告示・通知をご確認ください。 出典：
        <a
          href="https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000188411_00053.html"
          target="_blank"
          rel="noreferrer"
        >
          厚労省 ベースアップ評価料等について
        </a>
        （令和8年度診療報酬改定）。
      </p>
    </div>
  );
}
