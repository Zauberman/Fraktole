import 'package:flutter/material.dart';

import '../core/protocol/models.dart';
import '../state/app_controller.dart';
import 'tile_detail_screen.dart';

class TilesScreen extends StatefulWidget {
  const TilesScreen({super.key, required this.controller, required this.session});

  final AppController controller;
  final Session session;

  @override
  State<TilesScreen> createState() => _TilesScreenState();
}

class _TilesScreenState extends State<TilesScreen> {
  List<Tile>? _tiles;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.controller.tileStates.listen((event) {
      _applyTileState(event.tileId, event.alive, event.lines);
    });
    _reload();
  }

  void _applyTileState(String tileId, bool alive, int lines) {
    final tiles = _tiles;
    if (tiles == null || !mounted) return;
    final index = tiles.indexWhere((t) => t.id == tileId);
    if (index == -1) return;
    final updated = tiles[index];
    setState(() {
      _tiles![index] = Tile(
        id: updated.id,
        name: updated.name,
        kind: updated.kind,
        cwd: updated.cwd,
        lines: lines,
        lastActiveAgoSec: updated.lastActiveAgoSec,
      );
    });
  }

  Future<void> _reload() async {
    if (!mounted) return;
    setState(() => _loading = true);
    try {
      final tiles = await widget.controller.tiles(widget.session.id);
      if (!mounted) return;
      setState(() {
        _tiles = tiles;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.session.name),
        actions: [
          TextButton(onPressed: _reload, child: const Text('Refresh')),
        ],
      ),
      body: RefreshIndicator(onRefresh: _reload, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading && _tiles == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final error = _error;
    if (error != null && _tiles == null) {
      return _ErrorView(message: '$error', onRetry: _reload);
    }
    final tiles = _tiles ?? const <Tile>[];
    if (tiles.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 140),
          Center(
            child: Text(
              'No tiles in this session',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      );
    }
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(12),
      itemCount: tiles.length,
      itemBuilder: (context, index) => _TileCard(
        tile: tiles[index],
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => TileDetailScreen(
              controller: widget.controller,
              sessionId: widget.session.id,
              tile: tiles[index],
            ),
          ),
        ),
      ),
    );
  }
}

class _TileCard extends StatelessWidget {
  const _TileCard({required this.tile, required this.onTap});

  final Tile tile;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kindColor = switch (tile.kind) {
      'agent' => theme.colorScheme.primary,
      'reviewer' => theme.colorScheme.tertiary,
      _ => theme.colorScheme.secondary,
    };
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        title: Text(tile.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(tile.cwd, style: const TextStyle(fontSize: 11)),
            Text('${tile.lines} lines · active ${tile.lastActiveAgoSec}s ago',
                style: const TextStyle(fontSize: 11)),
          ],
        ),
        trailing: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: kindColor.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            tile.kind,
            style: TextStyle(fontSize: 11, color: kindColor),
          ),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 140),
        Center(
          child: Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14),
          ),
        ),
        Center(
          child: TextButton(onPressed: onRetry, child: const Text('Retry')),
        ),
      ],
    );
  }
}
