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

function assert_throws(estr, cb) {
  try {
    cb();
  } catch(e) {
    assert_eq(estr, e.toString());
    return;
  }
  throw 'Expected an exception.';
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

function test_comments() {
  var p = new PDFLexer(new Buffer("%xxxx%\n"));
  assert_eq(0, p.cur_pos());
  var t = p.consume_token_including_cmt_and_ws();
  assert_eq('cmt', t.t);
  assert_eq(6, p.cur_pos());

  p = new PDFLexer(new Buffer("%xxxx%"));
  assert_eq(0, p.cur_pos());
  var t = p.consume_token_including_cmt_and_ws();
  assert_eq('cmt', t.t);
  assert_eq(6, p.cur_pos());

  p = new PDFLexer(new Buffer("%xxxx\r"));
  assert_eq(0, p.cur_pos());
  var t = p.consume_token_including_cmt_and_ws();
  assert_eq('cmt', t.t);
  assert_eq(5, p.cur_pos());
}

function test_string_literals() {
  var strs = ['(yo yo)', '(yo(yo))', '(oo(())(()))'];
  var p = new PDFLexer(new Buffer(strs.join('')));
  for (var i = 0, il = strs.length; i < il; ++i) {
    var t = p.consume_token();
    assert_eq('str', t.t);
    assert_eq(strs[i].substr(1, strs[i].length - 2), t.v);
  }

  p = new PDFLexer(new Buffer("(blah \\063\\173 blah)"));
  var t = p.consume_token();
  assert_eq('str', t.t);
  assert_eq("blah 3{ blah", t.v);
}

function test_hexstring_literals() {
  var strs = ['<00FF>', "\x00\xff", '<34207d>', '4 }'];
  for (var i = 1, il = strs.length; i < il; i += 2) {
    var p = new PDFLexer(new Buffer(strs[i-1]));
    var t = p.consume_token();
    assert_eq('hexstr', t.t);
    assert_eq(strs[i], t.v);
    t = p.consume_token();
    assert_eq(null, t);
  }

  p = new PDFLexer(new Buffer("<0Z>"));
  assert_throws('Invalid character in hex string',
                function() { p.consume_token(); });
  p = new PDFLexer(new Buffer("<0FF>"));
  assert_throws('Odd number of digits in hex string',
                function() { p.consume_token(); });
}

test_eol();
test_comments();
test_string_literals();
test_hexstring_literals();
