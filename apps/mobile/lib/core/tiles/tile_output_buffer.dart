class TileOutputBuffer {
  TileOutputBuffer({this.maxLines = 2000});

  static final RegExp _ansiPattern = RegExp(
    r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]?',
  );

  final int maxLines;

  final List<String> _lines = [''];

  int get lineCount => _lines.length;

  List<String> get lines => List.unmodifiable(_lines);

  static String stripAnsi(String data) => data.replaceAll(_ansiPattern, '');

  void append(String data) {
    final cleaned = stripAnsi(data);
    for (final rune in cleaned.runes) {
      final char = String.fromCharCode(rune);
      if (char == '\n') {
        _lines.add('');
      } else if (char == '\r') {
        _lines[_lines.length - 1] = '';
      } else if (char == '\b') {
        final last = _lines.length - 1;
        final current = _lines[last];
        if (current.isNotEmpty) _lines[last] = current.substring(0, current.length - 1);
      } else if (rune < 32 && char != '\t') {
        continue;
      } else {
        _lines[_lines.length - 1] += char;
      }
    }
    _trim();
  }

  void reset(String data) {
    _lines
      ..clear()
      ..add('');
    append(data);
  }

  void clear() {
    _lines
      ..clear()
      ..add('');
  }

  void _trim() {
    if (_lines.length <= maxLines) return;
    final overflow = _lines.length - maxLines;
    _lines.removeRange(0, overflow);
  }
}
