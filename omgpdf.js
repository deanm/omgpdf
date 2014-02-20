// (c) 2014 Dean McNamee (dean@gmail.com)

var zlib = require('zlib');

function zero_pad(len, num) {
  var str = '' + num;
  return str.length >= len ? str :
         str = Array.prototype.join.call({length: len-str.length+1}, '0') + str;
}

// Adapted from omggif.  The LZW itself is the same, however the way the
// bitstream is encoded into bytes is different, and there are no subblocks.
function PDFLZWOutputIndexStream(code_stream, code_length, p,
                                 min_code_size, early_amount, output) {
  var clear_code = 1 << min_code_size;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  // NOTE: This shares the same name as the encoder, but has a different
  // meaning here.  Here this masks each code coming from the code stream.
  var code_mask = (1 << cur_code_size) - 1;
  var cur_shift = 0;  // Sort of a bit pointer tracking the MSB in |cur|.
  var cur = 0;

  var op = 0;  // Output pointer.

  // TODO(deanm): Would using a TypedArray be any faster?  At least it would
  // solve the fast mode / backing store uncertainty.
  // var code_table = Array(4096);
  var code_table = new Int32Array(4096);  // Can be signed, we only use 20 bits.

  var prev_code = null;  // Track code-1.

  while (true) {
    // Read up to two bytes, making sure we always 12-bits for max sized code.
    while (cur_shift < 16 && p < code_length) {
      cur = (cur << 8) | code_stream[p++];
      cur_shift += 8;
    }

    // TODO(deanm): We should never really get here, we should have received
    // and EOI.
    if (cur_shift < cur_code_size)
      break;

    cur_shift -= cur_code_size;
    var code = (cur >> cur_shift) & code_mask;

    // TODO(deanm): Maybe should check that the first code was a clear code,
    // at least this is what you're supposed to do.
    if (code === clear_code) {
      // We don't actually have to clear the table.  This could be a good idea
      // for greater error checking, but we don't really do any anyway.  We
      // will just track it with next_code and overwrite old entries.

      next_code = eoi_code + 1;
      cur_code_size = min_code_size + 1;
      code_mask = (1 << cur_code_size) - 1;

      // Don't update prev_code ?
      prev_code = null;
      continue;
    } else if (code === eoi_code) {
      break;
    }

    // We have a similar situation as the decoder, where we want to store
    // variable length entries (code table entries), but we want to do in a
    // faster manner than an array of arrays.  The code below stores sort of a
    // linked list within the code table, and then "chases" through it to
    // construct the dictionary entries.  When a new entry is created, just the
    // last byte is stored, and the rest (prefix) of the entry is only
    // referenced by its table entry.  Then the code chases through the
    // prefixes until it reaches a single byte code.  We have to chase twice,
    // first to compute the length, and then to actually copy the data to the
    // output (backwards, since we know the length).  The alternative would be
    // storing something in an intermediate stack, but that doesn't make any
    // more sense.  I implemented an approach where it also stored the length
    // in the code table, although it's a bit tricky because you run out of
    // bits (12 + 12 + 8), but I didn't measure much improvements (the table
    // entries are generally not the long).  Even when I created benchmarks for
    // very long table entries the complexity did not seem worth it.
    // The code table stores the prefix entry in 12 bits and then the suffix
    // byte in 8 bits, so each entry is 20 bits.

    var chase_code = code < next_code ? code : prev_code;

    // Chase what we will output, either {CODE} or {CODE-1}.
    var chase_length = 0;
    var chase = chase_code;
    while (chase > clear_code) {
      chase = code_table[chase] >> 8;
      ++chase_length;
    }

    var k = chase;

    // Already have the first byte from the chase, might as well write it fast.
    output[op++] = k;

    op += chase_length;
    var b = op;  // Track pointer, writing backwards.

    if (chase_code !== code)  // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff;  // Write backwards.
      chase >>= 8;  // Pull down to the prefix code.
    }

    if (prev_code !== null && next_code < 4096) {
      code_table[next_code++] = prev_code << 8 | k;
      // TODO(deanm): Figure out this clearing vs code growth logic better.  I
      // have an feeling that it should just happen somewhere else, for now it
      // is awkward between when we grow past the max and then hit a clear code.
      // For now just check if we hit the max 12-bits (then a clear code should
      // follow, also of course encoded in 12-bits).
      if (next_code+early_amount >= code_mask+1 && cur_code_size < 12) {
        ++cur_code_size;
        code_mask = code_mask << 1 | 1;
      }
    }

    prev_code = code;
  }

  return op;
}

function dict_has_key(dict, name) {
  var a = dict.v;
  for (var i = 1, il = a.length; i < il; i += 2) {
    if (a[i-1].v === name) return true;
  }
  return false;
}

function dict_get(dict, name) {
  var a = dict.v;
  for (var i = 1, il = a.length; i < il; i += 2) {
    if (a[i-1].v === name) return a[i];
  }
  return undefined;
}

function dict_del(dict, name) {
  var a = dict.v;
  for (var i = 1, il = a.length; i < il; i += 2) {
    if (a[i-1].v === name) {
      a.splice(i-1, 2);
      return true;
    }
  }
  return false;
}


function PDFLexer(buf) {
  var bufp = 0;
  var buflen = buf.length;

  this.cur_pos = function() { return bufp; };
  this.set_pos = function(p) { return bufp = p; };
  this.is_eof = function() { return bufp >= buflen; };
  this.cur_byte = function() { return buf[bufp]; }
  this.adv_byte = function() { bufp++; };
  this.adv_bytes = function(n) { bufp += n; };

  function ascii_substr(start, end) {
    return buf.toString('ascii', start, end);
  }

  // From the spec:
  //   "As a matter of convention, the tokens in a PDF file are arranged into
  //    lines; see Section 3.1, “Lexical Conventions.” Each line is terminated
  //    by an end-of-line (EOL) marker, which may be a carriage return
  //    (character code 13), a line feed (character code 10), or both."
  //   "The carriage return (CR) and line feed (LF) characters, also called
  //    newline characters, are treated as end-of-line (EOL) markers. The
  //    combination of a carriage return followed immediately by a line feed is
  //    treated as one EOL marker."
  this.consume_line = function() {
    var startp = bufp;
    // Seek to \r or \n.
    while (bufp < buflen && buf[bufp] !== 10 && buf[bufp] !== 13)
      ++bufp;
    var endp = bufp;
    // Seek past \r\n|\r|\n.
    bufp += (bufp+1 < buflen && buf[bufp] === 13 && buf[bufp+1] === 10) ? 2 : 1;
    return ascii_substr(startp, endp);
  };

  this.consume_line_bw = function() {
    --bufp;  // Cursor points after.
    // Seek past \r\n|\r|\n.
    bufp -= (bufp >= 1 && buf[bufp-1] === 13 && buf[bufp] === 10) ? 2 : 1;
    var endp = bufp + 1;
    // Seek to \r or \n.
    while (bufp >= 0 && buf[bufp] !== 10 && buf[bufp] !== 13)
      --bufp;
    bufp++;  // This is a bit fiddly, probably better to peek one before above?
    return ascii_substr(bufp, endp);
  };

  function consume_string_until_char(c) {
    var startp = bufp;
    while (bufp < buflen && buf[bufp++] !== c);
    return ascii_substr(startp, bufp-1);
  }

  this.consume_buffer_until_chars = function(chars) {
    var startp = bufp;
    var charslen = chars.length;
    for (; bufp+charslen < buflen; ++bufp) {
      var end = true;
      for (var i = 0; i < charslen; ++i) {
        if (buf[bufp + i] !== chars[i]) {
          end = false;
          break;
        }
      }
      if (end === true) break;
    }

    var data = buf.slice(startp, bufp);
    bufp += chars.length;
    return data;
  };

  this.consume_token_including_cmt_and_ws = function() {
    var startp = bufp;

    // 3.2.1 - Boolean Objects.
    if (buf[bufp+0] === 116 &&  /* t */
        buf[bufp+1] === 114 &&  /* r */
        buf[bufp+2] === 117 &&  /* u */
        buf[bufp+3] === 101) {  /* e */
      bufp += 4;
      return {v: true, t: 'bool', s: startp, e: bufp};
    }
    if (buf[bufp+0] === 102 &&  /* f */
        buf[bufp+1] ===  97 &&  /* a */
        buf[bufp+2] === 108 &&  /* l */
        buf[bufp+3] === 115 &&  /* s */
        buf[bufp+4] === 101) {  /* e */
      bufp += 5;
      return {v: false, t: 'bool', s: startp, e: bufp};
    }

    // 3.2.7 - Stream Objects.
    if (buf[bufp+0] === 115 &&  /* s */
        buf[bufp+1] === 116 &&  /* t */
        buf[bufp+2] === 114 &&  /* r */
        buf[bufp+3] === 101 &&  /* e */
        buf[bufp+4] ===  97 &&  /* a */
        buf[bufp+5] === 109) {  /* m */
      bufp += 6;
      return {v: false, t: 'stream', s: startp, e: bufp};
    }
    if (buf[bufp+0] === 101 &&  /* e */
        buf[bufp+1] === 110 &&  /* n */
        buf[bufp+2] === 100 &&  /* d */
        buf[bufp+3] === 115 &&  /* s */
        buf[bufp+4] === 116 &&  /* t */
        buf[bufp+5] === 114 &&  /* r */
        buf[bufp+6] === 101 &&  /* e */
        buf[bufp+7] ===  97 &&  /* a */
        buf[bufp+8] === 109) {  /* m */
      bufp += 9;
      return {v: false, t: 'endstream', s: startp, e: bufp};
    }

    // 3.2.8 - Null Object.
    if (buf[bufp+0] === 110 &&  /* n */
        buf[bufp+1] === 117 &&  /* u */
        buf[bufp+2] === 108 &&  /* l */
        buf[bufp+3] === 108) {  /* l */
      bufp += 4;
      return {v: null, t: 'null', s: startp, e: bufp};
    }

    // 3.2.9 - Indirect Objects.
    if (buf[bufp+0] === 111 &&  /* o */
        buf[bufp+1] ===  98 &&  /* b */
        buf[bufp+2] === 106) {  /* j */
      bufp += 3;
      return {v: false, t: 'obj', s: startp, e: bufp};
    }
    if (buf[bufp+0] === 101 &&  /* e */
        buf[bufp+1] === 110 &&  /* n */
        buf[bufp+2] === 100 &&  /* d */
        buf[bufp+3] === 111 &&  /* o */
        buf[bufp+4] ===  98 &&  /* b */
        buf[bufp+5] === 106) {  /* j */
      bufp += 6;
      return {v: false, t: 'endobj', s: startp, e: bufp};
    }

    if (buf[bufp+0] === 120 &&  /* x */
        buf[bufp+1] === 114 &&  /* r */
        buf[bufp+2] === 101 &&  /* e */
        buf[bufp+3] === 102) {  /* f */
      bufp += 4;
      return {v: null, t: 'xref', s: startp, e: bufp};
    }

    if (buf[bufp+0] === 115 &&  /* s */
        buf[bufp+1] === 116 &&  /* t */
        buf[bufp+2] ===  97 &&  /* a */
        buf[bufp+3] === 114 &&  /* r */
        buf[bufp+4] === 116 &&  /* t */
        buf[bufp+5] === 120 &&  /* x */
        buf[bufp+6] === 114 &&  /* r */
        buf[bufp+7] === 101 &&  /* e */
        buf[bufp+8] === 102) {  /* f */
      bufp += 9;
      return {v: null, t: 'startxref', s: startp, e: bufp};
    }

    // "The delimiter characters (, ), <, >, [, ], {, }, /, and % are special."
    switch (buf[bufp]) {
      // Whitespace.
      case 0: case 9: case 10: case 12: case 13: case 32:
        do {
          ++bufp;
        } while (buf[bufp] ===  0 || buf[bufp] ===  9 || buf[bufp] === 10 ||
                 buf[bufp] === 12 || buf[bufp] === 13 || buf[bufp] === 32);
        return {v: null, t: 'ws', s: startp, e: bufp};
      // Comments.
      case 37: /* % */
        while (buf[bufp] !== 10) ++bufp;  // Seek on newline.
        return {v: null, t: 'cmt', s: startp, e: bufp};
      // 3.2.2 - Numeric Objects.
      case 48:  /* 0 */ case 49:  /* 1 */ case 50:  /* 2 */ case 51:  /* 3 */
      case 52:  /* 4 */ case 53:  /* 5 */ case 54:  /* 6 */ case 55:  /* 7 */
      case 56:  /* 8 */ case 57:  /* 9 */ case 46:  /* . */ case 45:  /* - */
      case 43:  /* + */
        while (buf[bufp] === 48 ||  /* 0 */
               buf[bufp] === 49 ||  /* 1 */
               buf[bufp] === 50 ||  /* 2 */
               buf[bufp] === 51 ||  /* 3 */
               buf[bufp] === 52 ||  /* 4 */
               buf[bufp] === 53 ||  /* 5 */
               buf[bufp] === 54 ||  /* 6 */
               buf[bufp] === 55 ||  /* 7 */
               buf[bufp] === 56 ||  /* 8 */
               buf[bufp] === 57 ||  /* 9 */
               buf[bufp] === 46 ||  /* . */
               buf[bufp] === 45 ||  /* - */
               buf[bufp] === 43) {  /* + */
            ++bufp;
          }
          var str = buf.slice(startp, bufp).toString('ascii');
          return {v: parseFloat(str),
                  t: 'num', s: startp, e: bufp};
      // 3.2.3 - String Objects.
      case 40:  /* ( */
        var chars = [ ];
        while (bufp < buflen) {
          ++bufp;
          if (buf[bufp] === 92) { /* \ */
            ++bufp;
            switch (buf[bufp]) {
              case 110:  /* n */  chars.push("\n"); break;
              case 114:  /* r */  chars.push("\r"); break;
              case 116:  /* t */  chars.push("\t"); break;
              case  98:  /* b */  chars.push("\b"); break;
              case 102:  /* f */  chars.push("\f"); break;
              case  40:  /* ( */  chars.push("(");  break;
              case  41:  /* ) */  chars.push(")");  break;
              case  92:  /* \ */  chars.push("\\"); break;
              case  48:  /* 0 */ case  49:  /* 1 */
              case  50:  /* 2 */ case  51:  /* 3 */
                chars.push(String.fromCharCode(
                    parseInt(buf.slice(bufp, bufp+3).toString(ascii), 8)));
                break;
              default:
                --bufp; break;
            }
          } else if (buf[bufp] === 41) {  /* ) */
            ++bufp;
            break;
          } else {
            chars.push(String.fromCharCode(buf[bufp]));
          }
        }
        return {v: chars.join(''), t: 'str', s: startp, e: bufp};
      // 3.2.4 - Name Objects.
      case 47: /* / */
        // "The name may include any regular characters, but not delimiter or
        //  white-space characters"
        // "Note: The token / (a slash followed by no regular characters) is a
        //  valid name."
        while (true) {
          ++bufp;
          if (buf[bufp] ===   0 ||  /* \000 */
              buf[bufp] ===   9 ||  /* \t */
              buf[bufp] ===  10 ||  /* \n */
              buf[bufp] ===  12 ||  /* \f */
              buf[bufp] ===  13 ||  /* \r */
              buf[bufp] ===  32 ||  /*   */
              buf[bufp] ===  40 ||  /* ( */
              buf[bufp] ===  41 ||  /* ) */
              buf[bufp] ===  60 ||  /* < */
              buf[bufp] ===  62 ||  /* > */
              buf[bufp] ===  91 ||  /* [ */
              buf[bufp] ===  93 ||  /* ] */
              buf[bufp] === 123 ||  /* { */
              buf[bufp] === 125 ||  /* } */
              buf[bufp] ===  47 ||  /* / */
              buf[bufp] ===  37) {  /* % */
            break;
          }
        }
        return {v: buf.slice(startp, bufp).toString('ascii'), t: 'name',
                s: startp, e: bufp};
      // 3.2.5 - Array Objects.
      case 91: /* [ */
        ++bufp;
        return {v: null, t: '[', s: startp, e: bufp};
      case 93: /* ] */
        ++bufp;
        return {v: null, t: ']', s: startp, e: bufp};
      // 3.2.6 - Dictionary Objects.
      // 3.2.3 - String Objects (Hexadecimal Strings).
      case 60:  /* < */
        ++bufp;
        if (buf[bufp] === 60) {
          ++bufp;
          return {v: null, t: '<<', s: startp, e: bufp};
        } else {
          bufp = startp + 1;
          var str = consume_string_until_char(62);
          if (str.length & 1) throw "Odd number of characters in hex string";
          return {v: str, t: 'hexstr', s: startp, e: bufp};
        }
      case 62:  /* > */
        if (buf[bufp+1] !== 62) throw "Unexpected single > in lexer."
        bufp += 2;
          return {v: null, t: '>>', s: startp, e: bufp};
      // 3.2.9 - Indirect Objects.
      case 82:  /* R */
        ++bufp;
        return {v: false, t: 'objref', s: startp, e: bufp};
      default:
        throw "Lexer: " + buf[bufp];
    }
  };

  this.consume_token = function() {
    while (true) {
      var token = this.consume_token_including_cmt_and_ws();
      if (token.t !== 'ws' && token.t !== 'cmt') return token;
    }
  };
}

function PDF(raw) {
  var lexer = new PDFLexer(raw);
  var header = lexer.consume_line();

  function consume_objectish() {
    var token = lexer.consume_token();
    switch (token.t) {
      // 3.2.1 - Boolean Objects.
      case 'bool':
        return {v: token.v, t: 'bool'};
      // 3.2.2 - Numeric Objects.
      case 'num':
        // 3.2.9 - Indirect Objects.
        var savepos = lexer.cur_pos();
        var type = 'num';
        var peeked = [ ];
        for (var i = 0; i < 2; ++i) {
          var peek = lexer.consume_token();
          if (i === 0 && peek.t !== 'num') break;
          if (i === 1) {
            if (peek.t === 'obj' || peek.t === 'objref') type = peek.t;
          }
          peeked.push(peek);
        }

        if (type === 'num') {
          lexer.set_pos(savepos);
          return {v: token.v, t: 'num'};
        }

        var obj_id = token.v, obj_gen = peeked[0].v,
            obj_token = peeked[1];

        if (type === 'objref')
          return {v: {id: obj_id, gen: obj_gen}, t: 'objref'};

        var inner_obj = consume_object();
        if (consume_object().t !== '_endobj')
          throw "Unable to find endobj.";
        return {v: {id: obj_id, gen: obj_gen, v: inner_obj}, t: 'obj'};
      // 3.2.3 - String Objects.
      case 'str':
        return {v: token.v, t: 'str'};
      case 'hexstr':
        return {v: token.v, t: 'hexstr'};
      // 3.2.4 - Name Objects.
      case 'name':
        return {v: token.v, t: 'name'};
      // 3.2.5 - Array Objects.
      case '[':
        var objs = [ ];
        while (true) {
          var obj = consume_object();
          if (obj.t === '_]') break;
          objs.push(obj);
        }
        return {v: objs, t: 'array'};
      case ']':
        return {v: null, t: '_]'};
      // 3.2.6 - Dictionary Objects.
      case '<<':
        //   "Note: No two entries in the same dictionary should have the same
        //    key.  If a key does appear more than once, its value is
        //    undefined."
        var objs = [ ];
        while (true) {
          var obj = consume_object();
          if (obj.t === '_>>') break;
          objs.push(obj);
        }

        if (objs.length & 1) throw "Dictionary has odd number of elements.";

        var savepos = lexer.cur_pos();
        var nextobj = consume_object();
        if (nextobj !== null && nextobj.t === "_stream") {
          var s = {v: {d: {v: objs, t: 'dict'}, s: nextobj.v}, t: 'stream'};
          var len_obj = dict_get(s.v.d, '/Length');
          if (len_obj === undefined || len_obj.t !== 'num' ||
              len_obj.v !== s.v.s.length) {
            console.warn(
                "Stream length doesn't match /Length in dictionary: " +
                len_obj.v + " != " + s.v.s.length);
            if (s.v.s.length > len_obj.v) {
              console.warn('Trimming stream data to match /Length');
              s.v.s = s.v.s.slice(0, len_obj.v);
            }
          }
          return s;
        }

        lexer.set_pos(savepos);
        return {v: objs, t: 'dict'};
      case '>>':
        return {v: null, t: '_>>'};
      // 3.2.7 - Stream Objects.
      case 'stream':
        var kEndstream = [101, 110, 100, 115, 116, 114, 101, 97, 109];

        // "The keyword stream that follows the stream dictionary should be
        //  followed by an end-of-line marker consisting of either a carriage
        //  return and a line feed or just a line feed, and not by a carriage
        //  return alone."
        // Seek past \r?\n.
        if (lexer.cur_byte() === 13) lexer.adv_byte();
        if (lexer.cur_byte() !== 10)
          throw "Missing newline after stream keyword.";
        lexer.adv_byte();
        var streamdata = lexer.consume_buffer_until_chars(kEndstream);
        return {v: streamdata, t: '_stream'};
      case 'endstream':
        throw "Unexpected endstream";
      // 3.2.8 - Null Object.
      case 'null':
        return {v: null, t: 'null'};
      // 3.2.9 - Indirect Objects.
      case 'obj':
        throw "Unexpected obj";  // Handled above in 'num' token.
      case 'endobj':
        return {v: null, t: '_endobj'};
      case 'xref': case 'startxref':
        return null;  // EOF of body.
    }

    console.log("Unknown token: " + JSON.stringify(token));
    return null;
  }

  function consume_object() {
    var obj = undefined;
    while (!lexer.is_eof() && obj === undefined) obj = consume_objectish();
    return obj;
  }

  function emit_string(buf, bufp, str) {
    for (var i = 0, il = str.length; i < il; ++i) {
      buf[bufp++] = str.charCodeAt(i) & 0xff;
    }
    return bufp;
  }

  function emit_string_line(buf, bufp, str) {
    for (var i = 0, il = str.length; i < il; ++i) {
      buf[bufp++] = str.charCodeAt(i) & 0xff;
    }
    buf[bufp++] = 10;
    return bufp;
  }

  function emit_object(buf, bufp, obj) {
    switch (obj.t) {
      // 3.2.1 - Boolean Objects.
      case 'bool':
        bufp = emit_string(buf, bufp, obj.v === true ? 'true' : 'false');
        break;
      // 3.2.2 - Numeric Objects.
      case 'num':
        bufp = emit_string(buf, bufp, obj.v + '');
        break;
      // 3.2.3 - String Objects.
      case 'str':
        var str = obj.v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').
          replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\b]/g, '\\b').
          replace(/\f/g, '\\f').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        bufp = emit_string(buf, bufp, '(' + str + ')');
        break;
      case 'hexstr':
        bufp = emit_string(buf, bufp, '<' + obj.v + '>');
        break;
      // 3.2.4 - Name Objects.
      case 'name':
        bufp = emit_string(buf, bufp, obj.v);
        break;
      // 3.2.5 - Array Objects.
      case 'array':
        bufp = emit_string(buf, bufp, '[');
        var a = obj.v;
        for (var i = 0, il = a.length; i < il; ++i) {
          bufp = emit_object(buf, bufp, a[i]);
          bufp = emit_string(buf, bufp, ' ');
        }
        bufp = emit_string(buf, bufp, ']');
        break;
      // 3.2.6 - Dictionary Objects.
      case 'dict':
        bufp = emit_string(buf, bufp, '<<');
        var a = obj.v;
        // Personally I think this makes more sense space wise, because I would
        // Think that a dictionary like /Key1/Val1/Key2/Key2 should parse, but
        // I am just following an example PDF and it seems to just do
        // KEY1 VAL1KEY2 VAL2
        /*
        for (var i = 0, il = a.length; i < il; ++i) {
          if (a[i].t !== 'name')
            bufp = emit_string(buf, bufp, ' ');
          bufp = emit_object(buf, bufp, a[i]);
        }
        */
        for (var i = 1, il = a.length; i < il; i += 2) {
          bufp = emit_object(buf, bufp, a[i-1]);
          bufp = emit_string(buf, bufp, ' ');
          bufp = emit_object(buf, bufp, a[i]);
        }
        bufp = emit_string_line(buf, bufp, '>>');
        break;
      // 3.2.8 - Null Object.
      case 'null':
        bufp = emit_string(buf, bufp, 'null');
        break;
      // 3.2.9 - Indirect Objects.
      case 'obj':
        bufp = emit_string_line(buf, bufp, obj.v.id + ' ' + obj.v.gen + ' obj');
        bufp = emit_object(buf, bufp, obj.v.v);
        bufp = emit_string_line(buf, bufp, '');
        bufp = emit_string_line(buf, bufp, 'endobj');
        break;
      case 'objref':
        bufp = emit_string(buf, bufp, obj.v.id + ' ' + obj.v.gen + ' R');
        break;
      case 'stream':
        bufp = emit_object(buf, bufp, obj.v.d);
        bufp = emit_string_line(buf, bufp, 'stream');
        obj.v.s.copy(buf, bufp);
        bufp += obj.v.s.length;
        bufp = emit_string(buf, bufp, 'endstream');
        break;
      default:
        console.log('Unknown in emit: ' + obj.t);
    }
    return bufp;
  }

  this.write = function(buf) {
    var xref_table = [ ];

    var bufp = 0;

    bufp = emit_string_line(buf, bufp, header);
    bufp = emit_string_line(buf, bufp, "%\xc7\xec\x8f\xa2");

    for (var i = 0, il = body.length; i < il; ++i) {
      var obj = body[i];
      if (obj.t !== 'obj') throw "Non-object body object.";
      xref_table[obj.v.id] = bufp;
      bufp = emit_object(buf, bufp, obj);
    }

    var offset_to_xrefs = bufp;
    bufp = emit_string_line(buf, bufp, 'xref');
    bufp = emit_string_line(buf, bufp, '0 ' + xref_table.length);
    bufp = emit_string_line(buf, bufp, '0000000000 65535 f ');
    for (var i = 1, il = xref_table.length; i < il; ++i) {
      var val = xref_table[i];
      bufp = emit_string_line(buf, bufp, zero_pad(10, val) + ' 00000 n ');
    }
    bufp = emit_string_line(buf, bufp, 'trailer');
    bufp = emit_object(buf, bufp, trailer_dict);
    /*
    bufp = emit_object(buf, bufp, {v: [ {v: '/Size', t: 'name'},
                                        {v: xref_table.length, t: 'num'},
                                        {v: '/Root', t: 'name'},
                                        {v: '/Size', t: 'name'},
                                      ], t: 'dict'});
    */
    bufp = emit_string_line(buf, bufp, offset_to_xrefs + '');
    bufp = emit_string_line(buf, bufp, '%%EOF');
    return bufp;
  }

  function obj_key(obj) {
    if (obj.t !== 'obj' && obj.t !== 'objref') throw "Can't key object.";
    return obj.v.id + '_' + obj.v.gen;
  }

  function process_stream(stream, callback) {
    if (stream.t !== 'stream') throw "Not a stream.";
    var filter = dict_get(stream.v.d, '/Filter');
    if (filter === undefined) return callback(stream, false, stream.v.s);
    if (filter.v === '/FlateDecode') {
      //dict_del(stream.v.d, '/Filter');
      zlib.inflate(stream.v.s, function(err, res) {
        if (err !== null) throw err;
        callback(stream, true, res);
      });
    } else if (filter.v === '/LZWDecode') {
      /*
      // How do we get the output buffer size right?
      var output = new Buffer(1024 * 1024 * 10);
      var early_change = dict_get(stream.v.d, '/EarlyChange');
      var early_amount = (early_change !== undefined &&
                          early_change.t === 'num' &&
                          early_change.v === 0) ? 0 : 1;

      if (early_amount === 0)
        console.log("Warning, untested EarlyChange of 0.");

      var len = PDFLZWOutputIndexStream(
          stream.v.s, stream.v.s.length, 0, 8, early_amount, output);
      output = output.slice(0, len);
      */
      return callback(stream, false, stream.v.s);
    } else if (filter.v === '/DCTDecode') {
      return callback(stream, false, stream.v.s);
    } else {
      console.trace(stream.v.d);
      throw "Unknown stream filter.";
    }
  }

  var body = [ ];
  var objs = { };
  while (!lexer.is_eof()) {
    var obj = consume_object();
    if (obj === null) break;  // EOF.
    if (obj.t !== "obj") throw "Non-object object in body.";
    body.push(obj);
    var key = obj_key(obj);
    if (key in objs) throw "Duplicate key: " + key;
    objs[obj_key(obj)] = obj.v.v;
  }

  // if (consume_line() !== "xref") throw "Expected xref table.";

  var total_num_xref_entries = 0;
  while (true) {
    var line = lexer.consume_line();
    if (line.length === 0) continue;
    if (line === 'trailer') break;
    var pieces = line.split(' ');
    var first_object = parseInt(pieces[0]), num_entries = parseInt(pieces[1]);
    // each entry is 20 bytes long, including the new line.
    total_num_xref_entries += num_entries;
    lexer.adv_bytes(num_entries * 20);
  }

  var trailer_dict = consume_object();
  //console.log(trailer_dict);

  if (lexer.consume_line() !== '') throw "xx";
  if (lexer.consume_line() !== 'startxref') throw "Expected startxref.";
  var last_xref_section = parseInt(consume_line(), 10);
  if (lexer.consume_line() !== '%%EOF') throw "Expected %%EOF.";

  if (dict_get(trailer_dict, '/Size').v !== total_num_xref_entries)
    throw "/Size doesn't match number of xref entries.";

  var root = dict_get(trailer_dict, '/Root');
  if (!root || root.t !== 'objref')
    throw "Improper root.";

  this.process_streams = function(modifier, done) {
    var inflight = 1;  // "retain" guard against sync/async.
    for (var i = 0, il = body.length; i < il; ++i) {
      var obj = body[i];
      if (obj.t !== 'obj') throw "Non-object body object.";
      var inner = obj.v.v;
      if (inner.t !== 'stream') continue;
      ++inflight;
      process_stream(inner, function(inner, wasinflated, data) {
        if (!wasinflated) {
          if (--inflight === 0) done();
        } else {
          zlib.deflate(modifier(data), function(err, comp) {
            if (err !== null) throw "Error compressing.";
            inner.v.s = comp;
            if (--inflight === 0) done();
          });
        }
      });
    }
    if (--inflight === 0) done();  // "release" guard again sync/async.
  }

  /*
  var root_obj = objs[obj_key(root)];
  var pages = dict_get(root_obj, '/Pages');
  var pages_obj = objs[obj_key(pages)];
  var num_pages = dict_get(pages_obj, '/Count').v;
  console.log('Num pages: ' + num_pages);
  var kids = dict_get(pages_obj, '/Kids');
  for (var i = 0; i < num_pages; ++i) {
    var page = objs[obj_key(kids.v[i])];
    var contents = objs[obj_key(dict_get(page, '/Contents'))];
    console.log(process_stream(contents));
    console.log(contents);
    break;
  }
  */

  /*
  console.log(raw.slice(rawp).toString('utf8'));
  var last_xref_section_token = consume_token();
  console.log(last_xref_section_token);
  if (last_xref_section_token.t !== 'num') throw "xx";
  console.log(consume_token_including_cmt_and_ws());
  console.log(consume_token_including_cmt_and_ws());
  */

}

try {
  exports.PDF = PDF;
} catch(e) { };
