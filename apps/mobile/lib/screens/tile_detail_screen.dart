import 'dart:async';

import 'package:flutter/material.dart';

import '../core/protocol/models.dart';
import '../core/tiles/tile_output_buffer.dart';
import '../state/app_controller.dart';

class TileDetailScreen extends StatefulWidget {
  const TileDetailScreen({
    super.key,
    required this.controller,
    required this.sessionId,
    required this.tile,
  });

  final AppController controller;
  final String sessionId;
  final Tile tile;

  @override
  State<TileDetailScreen> createState() => _TileDetailScreenState();
}

class _TileDetailScreenState extends State<TileDetailScreen> {
  final TileOutputBuffer _buffer = TileOutputBuffer();
  final ScrollController _scrollController = ScrollController();
  final List<StreamSubscription<Object?>> _subscriptions = [];

  late bool _alive = widget.tile.lines > 0;
  late int _lines = widget.tile.lines;
  bool _autoScroll = true;
  bool _subscribed = false;

  @override
  void initState() {
    super.initState();
    _listen(widget.controller.tileSnapshots, (event) {
      if (event.tileId != widget.tile.id) return;
      _buffer.reset(event.data);
      _refresh();
    });
    _listen(widget.controller.tileOutputs, (event) {
      if (event.tileId != widget.tile.id) return;
      _buffer.append(event.data);
      _refresh();
    });
    _listen(widget.controller.tileStates, (event) {
      if (event.tileId != widget.tile.id) return;
      setState(() {
        _alive = event.alive;
        _lines = event.lines;
      });
    });
    _subscribe();
  }

  void _listen<T>(Stream<T> stream, void Function(T) handler) {
    _subscriptions.add(stream.listen(handler));
  }

  Future<void> _subscribe() async {
    try {
      await widget.controller.subscribeTile(
        sessionId: widget.sessionId,
        tileId: widget.tile.id,
      );
      if (!mounted) return;
      setState(() => _subscribed = true);
    } catch (_) {}
  }

  @override
  void dispose() {
    widget.controller.unsubscribeTile(tileId: widget.tile.id);
    for (final sub in _subscriptions) {
      sub.cancel();
    }
    _scrollController.dispose();
    super.dispose();
  }

  void _refresh() {
    if (!mounted) return;
    setState(() => _lines = _buffer.lineCount);
    if (!_autoScroll) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.tile.name),
            Text(
              '${widget.tile.kind} · $_lines lines',
              style: theme.textTheme.labelSmall,
            ),
          ],
        ),
        actions: [
          _StatusChip(alive: _alive, subscribed: _subscribed),
          TextButton(
            onPressed: () => setState(() => _autoScroll = !_autoScroll),
            child: Text(_autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'),
          ),
          TextButton(
            onPressed: () => setState(() => _buffer.clear()),
            child: const Text('Clear'),
          ),
        ],
      ),
      body: Container(
        color: const Color(0xFF0D0D12),
        child: _buffer.lines.isEmpty
            ? const Center(
                child: Text(
                  'No output yet',
                  style: TextStyle(color: Colors.white38, fontFamily: 'monospace'),
                ),
              )
            : Scrollbar(
                controller: _scrollController,
                child: ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: _buffer.lines.length,
                  itemBuilder: (context, index) => Text(
                    _buffer.lines[index],
                    style: const TextStyle(
                      color: Color(0xFFD8FFDC),
                      fontFamily: 'monospace',
                      fontSize: 12,
                      height: 1.35,
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.alive, required this.subscribed});

  final bool alive;
  final bool subscribed;

  @override
  Widget build(BuildContext context) {
    final color = subscribed
        ? (alive ? Colors.greenAccent : Colors.orangeAccent)
        : Colors.grey;
    return Center(
      child: Container(
        margin: const EdgeInsets.only(right: 8),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.6)),
        ),
        child: Text(
          subscribed ? (alive ? 'live' : 'idle') : '…',
          style: TextStyle(fontSize: 11, color: color),
        ),
      ),
    );
  }
}
