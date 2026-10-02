// ============================================================
// ORDERS + PRODUCT LIKES + COMMENTS + VISITORS — GOOGLE APPS SCRIPT (Web App)
// ============================================================
// doPost:
//   - visitor_type:"visitor" -> writes a row to the "Visitor" tab (auto-created)
//   - like_type:"like"       -> writes a row to the "Likes" tab (auto-created)
//   - comment_type:"comment" -> writes a row to the "Comments" tab (auto-created)
//   - action:"updateStatus"  -> updates the Status column (I) of an order
//   - otherwise              -> appends a new customer order row
// doGet:
//   - action:"comments" (& product_id) -> returns comments for a product
//   - action:"visitors"                -> returns recent visitors from "Visitor" tab
//   - action:"record_visitor"          -> records a visitor row via GET
//   - otherwise                        -> returns all order rows for the Admin Dashboard
//
// DEPLOY: Deploy > New deployment > Web app
//   Execute as: Me   |   Who has access: Anyone
// ============================================================

function jsonOk(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// The Orders tab: prefer a sheet literally named "Orders",
// otherwise the FIRST sheet (so the Likes tab never gets read as orders).
function getOrdersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var named = ss.getSheetByName("Orders") || ss.getSheetByName("Orders Data");
  if (named) return named;
  var sheets = ss.getSheets();
  return (sheets.length > 0) ? sheets[0] : ss.getActiveSheet();
}

// The Likes tab (auto-created with a header row on first use).
function getLikesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Likes");
  if (!sheet) {
    sheet = ss.insertSheet("Likes");
    sheet.appendRow(["Timestamp", "Product ID", "Product Name", "Likes Total", "Delta", "Action"]);
    sheet.getRange("1:1").setFontWeight("bold");
  }
  return sheet;
}

// The Comments tab (auto-created with a header row on first use).
function getCommentsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Comments");
  if (!sheet) {
    sheet = ss.insertSheet("Comments");
    sheet.appendRow(["Timestamp", "Product ID", "Product Name", "Name", "Comment", "Action"]);
    sheet.getRange("1:1").setFontWeight("bold");
  }
  return sheet;
}

// The Visitor tab (auto-created with a header row on first use).
function getVisitorSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Visitor") || ss.getSheetByName("Visitors");
  if (!sheet) {
    sheet = ss.insertSheet("Visitor");
    sheet.appendRow(["Timestamp", "IP Address", "IP Location", "City", "Region", "Country", "Device", "Browser", "Shop Name", "Page URL", "User Agent"]);
    sheet.getRange("1:1").setFontWeight("bold");
  }
  return sheet;
}

// 1. Save incoming order / update order status / record a like / record visitor
function doPost(e) {
  try {
    var data = {};
    if (e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); } catch (ex) { data = {}; }
    }

    // ---- VISITORS: write to the Visitor tab ----
    if (data.visitor_type === "visitor" || data.type === "visitor" || data.action === "record_visitor") {
      var visitorSheet = getVisitorSheet();
      var loc = data.ip_location || data.location || "";
      if (!loc) {
        var parts = [data.city, data.region, data.country].filter(Boolean);
        loc = parts.join(", ");
      }
      visitorSheet.appendRow([
        data.timestamp || new Date().toLocaleString(),
        data.ip || "",
        loc || "Unknown",
        data.city || "",
        data.region || "",
        data.country || "",
        data.device || "",
        data.browser || "",
        data.shop_name || "",
        data.page_url || "",
        data.user_agent || ""
      ]);
      return jsonOk({ status: 'success', type: 'visitor' });
    }

    // ---- LIKES: write to the Likes tab ----
    if (data.like_type === "like") {
      var likeSheet = getLikesSheet();
      likeSheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.product_id || "",
        data.product_name || "",
        data.likes || 0,
        data.delta || 0,
        "like"
      ]);
      return jsonOk({ status: 'success', type: 'like' });
    }

    // ---- COMMENTS: write to the Comments tab ----
    if (data.comment_type === "comment") {
      var commentSheet = getCommentsSheet();
      commentSheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.product_id || "",
        data.product_name || "",
        data.name || "Anonymous",
        data.comment || "",
        "comment"
      ]);
      return jsonOk({ status: 'success', type: 'comment' });
    }

    var sheet = getOrdersSheet();

    // ---- Order Status update from Admin Dashboard ----
    if (data.action === 'updateStatus') {
      var rowId = parseInt(data.row_id, 10);
      var newStatus = data.status || 'pending';
      if (rowId > 1 && rowId <= sheet.getLastRow()) {
        sheet.getRange(rowId, 9).setValue(newStatus); // Column 9 (I) is Status
        return jsonOk({ status: 'success' });
      }
      return jsonOk({ status: 'error', message: 'Invalid row_id' });
    }

    // ---- Otherwise, append new customer order ----
    sheet.appendRow([
      data.order_date || new Date().toLocaleString(),
      data.customer_name || '',
      data.customer_phone || '',
      data.customer_location || '',
      data.items || '',
      data.total || 0,
      data.currency || 'INR',
      data.customer_note || '',
      data.status || 'pending'
    ]);
    return jsonOk({ status: 'success' });
  } catch (err) {
    return jsonOk({ status: 'error', message: err.toString() });
  }
}

// 2. Fetch orders for Admin Dashboard, comments for a product, or visitors
function doGet(e) {
  var params = (e && e.parameter) || {};

  // ---- RECORD VISITOR (via GET beacon/fallback) ----
  if (params.action === "record_visitor") {
    var vSheet = getVisitorSheet();
    var loc = params.ip_location || params.location || "";
    if (!loc) {
      var parts = [params.city, params.region, params.country].filter(Boolean);
      loc = parts.join(", ");
    }
    vSheet.appendRow([
      params.timestamp || new Date().toLocaleString(),
      params.ip || "",
      loc || "Unknown",
      params.city || "",
      params.region || "",
      params.country || "",
      params.device || "",
      params.browser || "",
      params.shop_name || "",
      params.page_url || "",
      params.user_agent || ""
    ]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, type: 'visitor' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ---- VISITORS: return recent visitor logs ----
  if (params.action === "visitors" || params.action === "visitor") {
    var visitorSheet = getVisitorSheet();
    var vRows = visitorSheet.getDataRange().getValues();
    var visitors = [];
    for (var i = 1; i < vRows.length; i++) {
      if (!vRows[i][0] && !vRows[i][1]) continue;
      visitors.push({
        timestamp: vRows[i][0] instanceof Date ? vRows[i][0].toISOString() : String(vRows[i][0] || ""),
        ip: String(vRows[i][1] || ""),
        location: String(vRows[i][2] || ""),
        city: String(vRows[i][3] || ""),
        region: String(vRows[i][4] || ""),
        country: String(vRows[i][5] || ""),
        device: String(vRows[i][6] || ""),
        browser: String(vRows[i][7] || ""),
        shopName: String(vRows[i][8] || ""),
        pageUrl: String(vRows[i][9] || "")
      });
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, visitors: visitors }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ---- COMMENTS: return comments for a product (filtered by product_id) ----
  if (params.action === "comments") {
    var commentSheet = getCommentsSheet();
    var cRows = commentSheet.getDataRange().getValues();
    var comments = [];
    for (var i = 1; i < cRows.length; i++) {
      if (!cRows[i][4]) continue; // Skip rows without a comment
      if (params.product_id && String(cRows[i][1]) !== String(params.product_id)) continue;
      comments.push({
        timestamp: cRows[i][0] instanceof Date ? cRows[i][0].toISOString() : String(cRows[i][0] || ""),
        productId: String(cRows[i][1] || ""),
        productName: String(cRows[i][2] || ""),
        name: String(cRows[i][3] || "Anonymous"),
        comment: String(cRows[i][4] || "")
      });
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, comments: comments }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = getOrdersSheet();
  var rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[0] && !row[1] && !row[2]) continue; // Skip empty rows
    data.push({
      row_id: i + 1,
      order_date: row[0] instanceof Date ? row[0].toLocaleString() : String(row[0] || ''),
      customer_name: String(row[1] || ''),
      customer_phone: String(row[2] || ''),
      customer_location: String(row[3] || ''),
      items: String(row[4] || ''),
      total: parseFloat(row[5]) || 0,
      currency: String(row[6] || 'INR'),
      customer_note: String(row[7] || ''),
      status: String(row[8] || 'pending')
    });
  }
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}