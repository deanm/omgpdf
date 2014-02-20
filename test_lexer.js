// (c) 2014 Dean McNamee (dean@gmail.com)

var fs = require('fs');

// Instead of dealing with exporting, just load it into this context...
eval(fs.readFileSync('./omgpdf.js', 'utf8'));

function assert_eq(a, b) {
  if (a !== b) {
    var m = 'assert_eq: ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b);
    console.trace(m); throw m;
  }
}

function test_eol() {
  var p = new PDFLexer(new Buffer('boc\r\nboc\r\r\nboc\nboc\rboc\r\n'));
  // Forwards.
  assert_eq(0, p.cur_pos());
  assert_eq("boc", p.consume_line());
  assert_eq(5, p.cur_pos());
  assert_eq("boc", p.consume_line());
  assert_eq(9, p.cur_pos());
  assert_eq("", p.consume_line());
  assert_eq(11, p.cur_pos());
  assert_eq("boc", p.consume_line());
  assert_eq(15, p.cur_pos());
  assert_eq("boc", p.consume_line());
  assert_eq(19, p.cur_pos());
  assert_eq("boc", p.consume_line());
  assert_eq(24, p.cur_pos());
  // Backwards.
  assert_eq("boc", p.consume_line_bw());
  assert_eq(19, p.cur_pos());
  assert_eq("boc", p.consume_line_bw());
  assert_eq(15, p.cur_pos());
  assert_eq("boc", p.consume_line_bw());
  assert_eq(11, p.cur_pos());
  assert_eq("", p.consume_line_bw());
  assert_eq(9, p.cur_pos());
  assert_eq("boc", p.consume_line_bw());
  assert_eq(5, p.cur_pos());
  assert_eq("boc", p.consume_line_bw());
  assert_eq(0, p.cur_pos());
}

test_eol();
