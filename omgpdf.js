// (c) 2014 Dean McNamee (dean@gmail.com)

var pdfjsstream = require(__dirname + '/pdfjs-stream.js');

function zero_pad(len, num) {
  var str = '' + num;
  return str.length >= len ? str :
         str = Array.prototype.join.call({length: len-str.length+1}, '0') + str;
}

/*
function obj_type(o) {
  switch (typeof(o)) {
    case 'boolean':
      return 'bool';
    case 'string':
      return 'str';
    case 'number':
      //return (o|0) === o ? 'int' : 'real';
      return 'num';
  }

  if (o === null) return 'null';
  if (Array.isArray(o)) return 'array';
  if (o instanceof Name) return 'name';
  if (o instanceof Dictionary) return 'dict';
  if (o instanceof IndirectObject) return 'indobj';
  if (o instanceof ObjectReference) return 'objref';
  if (o instanceof Stream) return 'stream';

  return null;
}

function obj_is_type(o, typ) {
  switch (typ) {
    case 'bool':   return typeof(o) === 'boolean';
    case 'str':    return typeof(o) === 'string';
    case 'num':    return typeof(o) === 'number';
    case 'null':   return o === null;
    case 'array':  return Array.isArray(o);
    case 'name':   return o instanceof Name;
    case 'dict':   return o instanceof Dictionary;
    case 'indobj': return o instanceof IndirectObject;
    case 'objref': return o instanceof ObjectReference;
    case 'stream': return o instanceof Stream;
    default:       return false;
  }
}
*/

function obj_is_bool(o)   { return typeof(o) === 'boolean'; }
function obj_is_str(o)    { return typeof(o) === 'string'; }
function obj_is_num(o)    { return typeof(o) === 'number'; }
function obj_is_null(o)   { return o === null; }
function obj_is_array(o)  { return Array.isArray(o); }
function obj_is_name(o)   { return o instanceof Name; }
function obj_is_dict(o)   { return o instanceof Dictionary; }
function obj_is_indobj(o) { return o instanceof IndirectObject; }
function obj_is_objref(o) { return o instanceof ObjectReference; }
function obj_is_stream(o) { return o instanceof Stream; }

function Name(str) {
  this.str = str;
};

function Dictionary(a) {
  this.get = function(key) {
    for (var i = 1, il = a.length; i < il; i += 2) {
      if (a[i-1].str === key) return a[i];
    }
    return undefined;
  };

  this.get_checked = function(key, checker) {
    for (var i = 1, il = a.length; i < il; i += 2) {
      if (a[i-1].str === key) {
        var v = a[i];
        if (checker(v) !== true) throw 'get_checked expectation failed';
        return v;
      }
    }
    throw 'Key not in dictionary: ' + key;
  };

  this.has = function(key) {
    for (var i = 1, il = a.length; i < il; i += 2) {
      if (a[i-1].str === key) return true;
    }
    return false;
  };

  this.set = function(key, val) {
    for (var i = 1, il = a.length; i < il; i += 2) {
      if (a[i-1].str === key) {
        a[i] = val;
        return true;  // Replaced.
      }
    }

    a.push(new Name(key), val);
    return false;  // Inserted.
  };

  this.del = function(key) {
    for (var i = 1, il = a.length; i < il; i += 2) {
      if (a[i-1].str === key) {
        a.splice(i-1, 2);
        return true;
      }
    }
    return false;
  };
}

function IndirectObject(id, gen, obj) {
  this.id  = id;
  this.gen = gen;
  this.obj = obj;
}

function ObjectReference(id, gen) {
  this.id  = id;
  this.gen = gen;
}

function Stream(data, dict) {
  this.data = data;
  this.dict = dict;
}

function PDFLexer(buf) {
  var bufp = 0;
  var buflen = buf.length;

  this.cur_pos = function() { return bufp; };
  this.set_pos = function(p) { return bufp = p; };
  this.end_pos = function() { return buflen; };
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

  this.seek_to_chars_bw = function(chars) {  // Cursor lands on begin of chars.
    --bufp;  // Cursor points after.
    var charslen = chars.length;
    loop: for (; bufp >= 0; --bufp) {
      for (var i = 0; i < charslen; ++i) {
        if (buf[bufp + i] !== chars[i]) continue loop;
      }
      break;
    }
  }

  this.consume_token_including_cmt_and_ws = function() {
    if (bufp >= buflen) return null;

    var startp = bufp;

    // 3.2.1 - Boolean Objects.
    if (buf[bufp+0] === 116 &&  /* t */
        buf[bufp+1] === 114 &&  /* r */
        buf[bufp+2] === 117 &&  /* u */
        buf[bufp+3] === 101) {  /* e */
      bufp += 4;
      return {v: true, t: 'bool'};
    }
    if (buf[bufp+0] === 102 &&  /* f */
        buf[bufp+1] ===  97 &&  /* a */
        buf[bufp+2] === 108 &&  /* l */
        buf[bufp+3] === 115 &&  /* s */
        buf[bufp+4] === 101) {  /* e */
      bufp += 5;
      return {v: false, t: 'bool'};
    }

    // 3.2.7 - Stream Objects.
    if (buf[bufp+0] === 115 &&  /* s */
        buf[bufp+1] === 116 &&  /* t */
        buf[bufp+2] === 114 &&  /* r */
        buf[bufp+3] === 101 &&  /* e */
        buf[bufp+4] ===  97 &&  /* a */
        buf[bufp+5] === 109) {  /* m */
      bufp += 6;
      return {v: false, t: 'stream'};
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
      return {v: false, t: 'endstream'};
    }

    // 3.2.8 - Null Object.
    if (buf[bufp+0] === 110 &&  /* n */
        buf[bufp+1] === 117 &&  /* u */
        buf[bufp+2] === 108 &&  /* l */
        buf[bufp+3] === 108) {  /* l */
      bufp += 4;
      return {v: null, t: 'null'};
    }

    // 3.2.9 - Indirect Objects.
    if (buf[bufp+0] === 111 &&  /* o */
        buf[bufp+1] ===  98 &&  /* b */
        buf[bufp+2] === 106) {  /* j */
      bufp += 3;
      return {v: false, t: 'obj'};
    }
    if (buf[bufp+0] === 101 &&  /* e */
        buf[bufp+1] === 110 &&  /* n */
        buf[bufp+2] === 100 &&  /* d */
        buf[bufp+3] === 111 &&  /* o */
        buf[bufp+4] ===  98 &&  /* b */
        buf[bufp+5] === 106) {  /* j */
      bufp += 6;
      return {v: false, t: 'endobj'};
    }

    if (buf[bufp+0] === 120 &&  /* x */
        buf[bufp+1] === 114 &&  /* r */
        buf[bufp+2] === 101 &&  /* e */
        buf[bufp+3] === 102) {  /* f */
      bufp += 4;
      return {v: null, t: 'xref'};
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
      return {v: null, t: 'startxref'};
    }

    // "The delimiter characters (, ), <, >, [, ], {, }, /, and % are special."

    var c = buf[bufp];
    switch (c) {
      // Whitespace.
      case 0: case 9: case 10: case 12: case 13: case 32:
        do {
          c = buf[++bufp];
        } while (c ===  0 || c ===  9 || c === 10 ||
                 c === 12 || c === 13 || c === 32);
        return {v: null, t: 'ws'};
      // Comments.
      case 37: /* % */
        // Seek up to newline.  Let the lexer process as whitespace next pass.
        while (bufp < buflen && c !== 10 && c !== 13) c = buf[++bufp];
        return {v: null, t: 'cmt'};
      // 3.2.2 - Numeric Objects.
      case 48:  /* 0 */ case 49:  /* 1 */ case 50:  /* 2 */ case 51:  /* 3 */
      case 52:  /* 4 */ case 53:  /* 5 */ case 54:  /* 6 */ case 55:  /* 7 */
      case 56:  /* 8 */ case 57:  /* 9 */ case 46:  /* . */ case 45:  /* - */
      case 43:  /* + */
        do {
          c = buf[++bufp];
        } while (c === 48 ||  /* 0 */
                 c === 49 ||  /* 1 */
                 c === 50 ||  /* 2 */
                 c === 51 ||  /* 3 */
                 c === 52 ||  /* 4 */
                 c === 53 ||  /* 5 */
                 c === 54 ||  /* 6 */
                 c === 55 ||  /* 7 */
                 c === 56 ||  /* 8 */
                 c === 57 ||  /* 9 */
                 c === 46 ||  /* . */
                 c === 45 ||  /* - */
                 c === 43);   /* + */
          return {v: parseFloat(ascii_substr(startp, bufp)), t: 'num'};
      // 3.2.3 - String Objects.
      case 40:  /* ( */
        var bytes = [ ];
        var nest = 0;  // Literal strings support "balanced paranthesis".
        while (bufp < buflen) {
          c = buf[++bufp];
          if (c === 92) { /* \ */
            c = buf[++bufp];
            switch (c) {
              case 110:  /* n */  bytes.push(10); break;
              case 114:  /* r */  bytes.push(13); break;
              case 116:  /* t */  bytes.push( 9); break;
              case  98:  /* b */  bytes.push( 8); break;
              case 102:  /* f */  bytes.push(12); break;
              case  40:  /* ( */  bytes.push(40);  break;
              case  41:  /* ) */  bytes.push(41);  break;
              case  92:  /* \ */  bytes.push(92); break;
              case  48:  /* 0 */ case  49:  /* 1 */
              case  50:  /* 2 */ case  51:  /* 3 */
                // TODO: Range check the octal <= 255.
                bytes.push(parseInt(ascii_substr(bufp, bufp+3), 8));
                bufp += 2;
                break;
              default:
                --bufp; break;
            }
          } else if (c === 41 && nest === 0) {  /* ) */
            ++bufp;
            break;
          } else {
            if (c === 40) ++nest;  /* ( */
            if (c === 41) --nest;  /* ) */
            bytes.push(c);
          }
        }
        return {v: String.fromCharCode.apply(null, bytes), t: 'str'};
      // 3.2.4 - Name Objects.
      case 47: /* / */
        // "The name may include any regular characters, but not delimiter or
        //  white-space characters"
        // "Note: The token / (a slash followed by no regular characters) is a
        //  valid name."
        do {
          c = buf[++bufp];
        } while (bufp < buflen && 
                 c !==   0 &&  /* \000 */
                 c !==   9 &&  /* \t */
                 c !==  10 &&  /* \n */
                 c !==  12 &&  /* \f */
                 c !==  13 &&  /* \r */
                 c !==  32 &&  /*   */
                 c !==  40 &&  /* ( */
                 c !==  41 &&  /* ) */
                 c !==  60 &&  /* < */
                 c !==  62 &&  /* > */
                 c !==  91 &&  /* [ */
                 c !==  93 &&  /* ] */
                 c !== 123 &&  /* { */
                 c !== 125 &&  /* } */
                 c !==  47 &&  /* / */
                 c !==  37);   /* % */
        return {v: ascii_substr(startp, bufp), t: 'name'};
      // 3.2.5 - Array Objects.
      case 91: /* [ */
        ++bufp;
        return {v: null, t: '['};
      case 93: /* ] */
        ++bufp;
        return {v: null, t: ']'};
      // 3.2.6 - Dictionary Objects.
      // 3.2.3 - String Objects (Hexadecimal Strings).
      case 60:  /* < */
        c = buf[++bufp];
        if (c === 60) {  /* < */
          ++bufp;
          return {v: null, t: '<<'};
        } else {
          var bytes = [ ];
          var num_digits = 0;
          digi: for (var b = 0; bufp < buflen; ++num_digits, c = buf[++bufp]) {
            var base = 0;

            switch (c) {
              case 48: case 49: case 50: case 51: case 52:
              case 53: case 54: case 55: case 56: case 57:              // 0-9
                base = 48; break;
              case 65: case 66: case 67: case 68: case 69: case 70:     // A-F
                base = 55; break;
              case 97: case 98: case 99: case 100: case 101: case 102:  // a-f
                base = 87; break;
              case 62:                                                  // >
                ++bufp; break digi;
              default:
                throw 'Invalid character in hex string';
            }

            b = (b << 4) | (c - base);
            if (num_digits & 1 === 1) {
              bytes.push(b);
              b = 0;
            }
          }

          if (num_digits & 1 === 1) throw "Odd number of digits in hex string";

          // TODO: Is it right to just treat this as a string?  It is safe to
          // go to fromCharCode and back for all 8-bit, so just use a string.
          var str = String.fromCharCode.apply(null, bytes);
          return {v: str, t: 'hexstr'};
        }
      case 62:  /* > */
        if (buf[bufp+1] !== 62) throw "Unexpected single > in lexer"
        bufp += 2;
        return {v: null, t: '>>'};
      // 3.2.9 - Indirect Objects.
      case 82:  /* R */
        ++bufp;
        return {v: false, t: 'objref'};
      default:
        throw "Unexpected character in lexer: " + buf[bufp] + ' at ' + bufp;
    }
  };

  this.consume_token = function() {
    while (bufp < buflen) {
      var token = this.consume_token_including_cmt_and_ws();
      if (token.t !== 'ws' && token.t !== 'cmt') return token;
    }
    return null;
  };
}

function PDFWriter(buf) {

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

  this.write = function(header, body, tailer_dict) {
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
}

function PDFReader(raw) {
  var lexer = new PDFLexer(raw);

  var kDummyObjectRightBracket = { };
  var kDummyObjectRightChevron = { };
  var kDummyObjectEndObj       = { };

  function consume_objectish() {
    var token = lexer.consume_token();
    switch (token.t) {
      // 3.2.1 - Boolean Objects.
      case 'bool':
        return token.v;  // bool
      // 3.2.2 - Numeric Objects.
      case 'num':
        // 3.2.9 - Indirect Objects.
        var savepos = lexer.cur_pos();
        var typ = 'num';
        var peeked = [ ];
        for (var i = 0; i < 2; ++i) {
          var peek = lexer.consume_token();
          if (i === 0 && peek.t !== 'num') break;
          if (i === 1) {
            if (peek.t === 'obj' || peek.t === 'objref') typ = peek.t;
          }
          peeked.push(peek);
        }

        if (typ === 'num') {
          lexer.set_pos(savepos);
          return token.v;  // num
        }

        var obj_id = token.v, obj_gen = peeked[0].v,
            obj_token = peeked[1];

        if (typ === 'objref')
          return new ObjectReference(obj_id, obj_gen);

        var inner_obj = consume_object();
        if (consume_object() !== kDummyObjectEndObj)
          throw "Unable to find endobj.";
        return new IndirectObject(obj_id, obj_gen, inner_obj);
      // 3.2.3 - String Objects.
      case 'str':
      case 'hexstr':
        return token.v;  // str
      // 3.2.4 - Name Objects.
      case 'name':
        return new Name(token.v);
      // 3.2.5 - Array Objects.
      case '[':
        var objs = [ ];
        while (true) {
          var obj = consume_object();
          if (obj === kDummyObjectRightBracket) break;
          objs.push(obj);
        }
        return objs;  // array
      case ']':
        return kDummyObjectRightBracket;
      // 3.2.6 - Dictionary Objects.
      case '<<':
        //   "Note: No two entries in the same dictionary should have the same
        //    key.  If a key does appear more than once, its value is
        //    undefined."
        var objs = [ ];
        while (true) {
          var obj = consume_object();
          if (obj === kDummyObjectRightChevron) break;
          objs.push(obj);
        }

        if (objs.length & 1) throw "Dictionary has odd number of elements.";

        var dict = new Dictionary(objs);

        var savepos = lexer.cur_pos();
        var s = consume_object();
        if (s !== null && s instanceof Stream) {  // Process dict+stream.
          s.dict = dict;
          var streamlen = dict.get_checked('/Length', obj_is_num);
          if (streamlen !== s.data.length) {
            // We don't properly handle EOL in the stream consumption, so we
            // assume if we're off by 1 or 2 it's because of EOL markers.
            if (s.data.length > streamlen && s.data.length - streamlen <= 2) {
              if (s.data.length - streamlen == 2) {
                if (s.data[streamlen] !== 13 || s.data[streamlen+1] !== 10)
                  throw 'Invalid stream EOL.';
              } else {
                if (s.data[streamlen] !== 10) throw 'Invalid stream EOL.';
              }
              s.data = s.data.slice(0, streamlen);
            } else {
              throw "Stream length doesn't match /Length in dictionary: " +
                    streamlen + " != " + s.data.length;
            }
          }
          return s;  // stream
        }

        lexer.set_pos(savepos);
        return dict;  // dict
      case '>>':
        return kDummyObjectRightChevron;
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
        // NOTE: This just takes everything up to 'endstream', without looking
        // at the stream dictionary.  I suppose this is potentially dangerous,
        // for example if it is allowed for the text 'endstream' to be
        // contained within a stream body.  Additionally we don't handle EOL
        // here, the spec says:
        // "It is recommended that there be an end-of-line marker after the data
        //  and before endstream; this marker is not included in the stream
        //  length."
        var streamdata = lexer.consume_buffer_until_chars(kEndstream);
        // TODO: protect this from coming in without a dictionary, it should
        // only be produced in the above code handling <<.
        return new Stream(streamdata, null);
      case 'endstream':
        throw "Unexpected endstream";
      // 3.2.8 - Null Object.
      case 'null':
        return null;  // null
      // 3.2.9 - Indirect Objects.
      case 'obj':
        throw "Unexpected obj";  // Handled above in 'num' token.
      case 'endobj':
        return kDummyObjectEndObj;
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

  function consume_object_at(offset) {
    var savepos = lexer.cur_pos();
    lexer.set_pos(offset);
    var obj = consume_object();
    lexer.set_pos(savepos);
    return obj;
  }

  function obj_key(obj) {
    if (!obj_is_indobj(obj) && !obj_is_objref(obj)) throw "Can't key object.";
    return obj.id + '_' + obj.gen;
  }

  function make_filter_stream(typ, stream, dict) {
    var params_dict = dict.get('/DecodeParms');
    var params = null;
    if (obj_is_dict(params_dict)) {
      var params = {
        get: function(x) {
          return params_dict.get('/' + x);
        },
      };
    }

    switch (typ) {
      case '/FlateDecode':
        var filter = null;
        if (params !== null) {
          return new pdfjsstream.PredictorStream(
              new pdfjsstream.FlateStream(stream), params);
        }
        return new pdfjsstream.FlateStream(stream);
      case '/LZWDecode':
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
        throw 'xx';
      case '/CCITTFaxDecode': case '/CCF':
        return new pdfjsstream.CCITTFaxStream(stream, params);
      default:
        return null;
        //throw "Unknown stream filter: " + typ;
    }
  }

  function filter_stream(stream) {
    if (!obj_is_stream(stream)) throw "Not a stream.";
    var filter = stream.dict.get('/Filter');
    if (!obj_is_name(filter)) return stream.data;

    var data = new Uint8Array(stream.data);
    var filter_stream = make_filter_stream(
        filter.str, new pdfjsstream.Stream(data), stream.dict);
    if (filter_stream === null) return null;
    return filter_stream.getBytes();
  }

  this.process_streams = function(callback) {
    for (var i = 0, il = xref_table.length; i < il; ++i) {
      var xref = xref_table[i];
      if (!xref) continue;  // FIXME Free entries?
      if (xref.o !== null) continue;  // TODO
      var obj = consume_object_at(xref.i);
      if (!obj_is_indobj(obj)) throw "Non-object body object.";
      var inner = obj.obj;
      if (!obj_is_stream(inner)) continue;
      var data = filter_stream(inner);
      if (data === null) {
        //callback(inner, false, inner.data);
        //inner.v.s = callback(data);
      } else {
        callback(inner, true, data);
        //inner.v.s = callback(data);
      }
    }
  };

  // Parse through the PDF.  There are a lot of different possibilities,
  // updated PDFs, linearized, etc.  Not everything is supported yet.
  // The best approach seems to be to work from the end of the file.

  var first_trailer_dict = null;
  var trailer_dict = null;
  var num_objects = null;

  function process_trailer() {
    if (lexer.consume_line() !== 'trailer') throw 'Expected trailer';
    trailer_dict = consume_object();

    if (num_objects === null) {  // Appears right to keep the first /Size.
      var num_objects_obj = trailer_dict.get('/Size');
      if (!obj_is_num(num_objects_obj))
        throw 'Invalid /Size in trailer dictionary.';
      num_objects = num_objects_obj;
    }

    if (first_trailer_dict === null) first_trailer_dict = trailer_dict;
  }

  var xref_table = [ ];
  var total_num_xref_entries = 0;

  function process_xref_table() {
    while (true) {  // xref sections.
      var line = lexer.consume_line();
      if (line.length === 0) continue;
      if (line === 'trailer') break;  // TODO: correct?
      var pieces = line.split(' ');
      var first_object = parseInt(pieces[0]), num_entries = parseInt(pieces[1]);
      total_num_xref_entries += num_entries;
      //console.log([first_object, num_entries]);

      // each entry is 20 bytes long, including the new line.
      var end_of_section = lexer.cur_pos() + num_entries * 20;
      for (var i = 0; i < num_entries; ++i) {
        line = lexer.consume_line();
        pieces = line.split(' ');
        var offset = parseInt(pieces[0]), gen = parseInt(pieces[1]);
        // FIXME: gen ?
        if (pieces[2] === 'n') {
          if (first_object + i in xref_table) throw 'dup';  // FIXME updates.
          xref_table[first_object + i] = {o: null, i: offset};
        } else {   // FIXME: Not sure
          //console.log(pieces);
        }
      }
      lexer.set_pos(end_of_section);  // Just to make sure we seeked properly.
    }
  }

  function process_xref_stream() {
    var xref_stream_obj = consume_object();
    if (!obj_is_indobj(xref_stream_obj))
      throw "Expected xref stream object.";
    var xref_stream = xref_stream_obj.obj;
    if (!obj_is_stream(xref_stream))
      throw "Expected xref stream.";

    trailer_dict = xref_stream.dict;

    if (trailer_dict.get_checked('/Type', obj_is_name).str !== '/XRef')
      throw 'Invalid xref stream type.';

    var size = trailer_dict.get_checked('/Size', obj_is_num);

    if (num_objects === null)  // Appears right to keep the first /Size.
      num_objects = size;

    var index = [0, size];
    if (trailer_dict.has('/Index')) {
      index = trailer_dict.get_checked('/Index', obj_is_array);
      for (var i = 0, il = index.length; i < il; ++i) {
        if (!obj_is_num(index[i])) throw 'Non-number in /Index';
      }
    }

    var w_obj = trailer_dict.get('/W');
    if (!obj_is_array(w_obj) || w_obj.length !== 3)
      throw 'Invalid /W entry.';
    for (var i = 0, il = w_obj.length; i < il; ++i) {
      if (!obj_is_num(w_obj[i])) throw 'Non-number in /W';
    }
    var ws0 = w_obj[0], ws1 = w_obj[1], ws2 = w_obj[2];

    var xref_data = filter_stream(xref_stream);

    var p = 0;
    for (var i = 1, il = index.length; i < il; i += 2) {
      var first_object = index[i-1];
      var num_entries = index[i];
      total_num_xref_entries += num_entries;
      for (var j = 0; j < num_entries; ++j) {
        var f0 = (ws0 === 0) ? 1: 0, f1 = 0, f2 = 0;
        // TODO(deanm): Check xref_data bounds.
        for (var w = 0; w < ws0; ++w) f0 = (f0 << 8) | xref_data[p++];
        for (var w = 0; w < ws1; ++w) f1 = (f1 << 8) | xref_data[p++];
        for (var w = 0; w < ws2; ++w) f2 = (f2 << 8) | xref_data[p++];

        switch (f0) {
          case 0:
            // TODO Free objects... need to do anything?
            break;
          case 1:
            if (first_object + j in xref_table) throw 'dup';  // FIXME updates.
            xref_table[first_object + j] = {o: null, i: f1};
            // TODO gen?
            if (f2 !== 0) throw "Do something with gen...";
            break;
          case 2:
            if (first_object + j in xref_table) throw 'dup';  // FIXME updates.
            xref_table[first_object + j] = {o: f1, i: f2};
            break;
          default:
            throw 'Invalid xref type.';
        }
      }
    }

    if (first_trailer_dict === null) first_trailer_dict = trailer_dict;
  }

  // First check the header at the beginning of the file.
  var header = lexer.consume_line();
  if (!/^%PDF-1\.[2-7]$/.test(header))  // TODO: Work out properly.
    throw "Unsupported PDF version? " + header;

  var linearized_dict = null;  // Non-null means file is linearized.
  // NOTE: consume_object will eat through the comment that might be there to
  // indicate that the file is binary, no special handling for that needed.
  var maybe_linear_obj = consume_object();
  if (obj_is_indobj(maybe_linear_obj) &&
      obj_is_dict(maybe_linear_obj.obj)) {
    var lin_obj = maybe_linear_obj.obj.get('/Linearized');
    if (obj_is_num(lin_obj) && lin_obj === 1)
      linearized_dict = lin_obj;
  }

  // console.log(linearized_dict !== null);

  // Start working from the end.
  lexer.set_pos(lexer.end_pos());

  if (lexer.consume_line_bw() !== '%%EOF') throw 'Expected %%EOF';
  var byte_offset_to_last_xref = parseInt(lexer.consume_line_bw());
  if (lexer.consume_line_bw() !== 'startxref') throw 'Expected startxref';
  // This is a bit ugly, but without making the lexer run backwards it is
  // probably the easiest thing.  Search back to a beginning << and then back
  // further to the trailer, hopefully we get to the right place.
  lexer.seek_to_chars_bw([60, 60]);  // <<.
  lexer.seek_to_chars_bw([116, 114, 97, 105, 108, 101, 114]);  // trailer.

  lexer.set_pos(byte_offset_to_last_xref);

  while (true) {
    // console.log('Processing table at: ' + lexer.cur_pos());
    var savepos = lexer.cur_pos();
    if (lexer.consume_line() === "xref") {  // Normwal xref table.
      process_xref_table();
      if (lexer.consume_line_bw() !== 'trailer') throw 'Expected trailer.';
      process_trailer();
    } else {  // Rewind and try to process it as a xref stream.
      lexer.set_pos(savepos);
      process_xref_stream();
    }

    var prev_obj = trailer_dict.get('/Prev');
    if (obj_is_num(prev_obj)) {
      lexer.set_pos(prev_obj);  // Repeat.
    } else {
      break;
    }
  }

  if (num_objects !== total_num_xref_entries ||
      num_objects !== xref_table.length) {
    console.trace([num_objects, total_num_xref_entries, xref_table.length]);
    throw 'Mismatch between xref table size and /Size.';
  }

  var root = first_trailer_dict.get('/Root');
  if (!obj_is_objref(root))
    throw "Invalid /Root in trailer dictionary.";

  /*
  var body = [ ];
  var objs = { };
  while (!lexer.is_eof()) {
    var obj = consume_object();
    if (obj === null) break;  // EOF.
    if (obj.t !== "obj") throw "Non-object object in body.";
    body.push(obj);
    var key = obj_key(obj);
    if (key in objs) {
      console.log("Duplicate key, update? " + key);
    } else {
      objs[obj_key(obj)] = obj.v.v;
    }
  }
  */

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

}

try {
  exports.PDFReader = PDFReader;
  exports.PDFWriter = PDFWriter;
} catch(e) { };
