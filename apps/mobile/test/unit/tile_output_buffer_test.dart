import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/tiles/tile_output_buffer.dart';

void main() {
  group('TileOutputBuffer', () {
    test('strips ANSI escape sequences', () {
      final buffer = TileOutputBuffer();
      buffer.append('\x1b[32mgreen\x1b[0m text');
      expect(buffer.lines.first, 'green text');
    });

    test('splits lines on newline', () {
      final buffer = TileOutputBuffer();
      buffer.append('line1\nline2');
      expect(buffer.lines, ['line1', 'line2']);
    });

    test('carriage return resets current line', () {
      final buffer = TileOutputBuffer();
      buffer.append('old\rnew');
      expect(buffer.lines.first, 'new');
    });

    test('respects max lines', () {
      final buffer = TileOutputBuffer(maxLines: 5);
      for (var i = 0; i < 10; i++) {
        buffer.append('line$i\n');
      }
      expect(buffer.lineCount, 5);
      expect(buffer.lines[3], 'line9');
      expect(buffer.lines.last, '');
    });

    test('snapshot resets prior content', () {
      final buffer = TileOutputBuffer();
      buffer.append('stale\n');
      buffer.reset('fresh');
      expect(buffer.lines, ['fresh']);
    });
  });
}
