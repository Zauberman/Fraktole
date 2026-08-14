import 'package:flutter/material.dart';

import '../core/protocol/models.dart';
import '../state/app_controller.dart';
import 'tiles_screen.dart';

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  List<Session>? _sessions;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.controller.sessionStates.listen((event) => _reload());
    _reload();
  }

  Future<void> _reload() async {
    if (!mounted) return;
    setState(() => _loading = true);
    try {
      final sessions = await widget.controller.sessions();
      if (!mounted) return;
      setState(() {
        _sessions = sessions;
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
      appBar: AppBar(title: const Text('Sessions')),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _sessions == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final error = _error;
    if (error != null && _sessions == null) {
      return _ErrorView(message: '$error', onRetry: _reload);
    }
    final sessions = _sessions ?? const <Session>[];
    if (sessions.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 140),
          Center(
            child: Text(
              'No sessions yet',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
          ),
          SizedBox(height: 6),
          Center(
            child: Text(
              'Start a session on the desktop to see it here.',
              style: TextStyle(fontSize: 12),
            ),
          ),
        ],
      );
    }
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(12),
      itemCount: sessions.length,
      itemBuilder: (context, index) => _SessionCard(
        session: sessions[index],
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => TilesScreen(
              controller: widget.controller,
              session: sessions[index],
            ),
          ),
        ),
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session, required this.onTap});

  final Session session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        title: Text(
          session.name,
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (session.project.isNotEmpty)
              Text('${session.project} · ${session.tileCount} tiles'),
            if (session.updatedAt != null)
              Text(_relativeTime(session.updatedAt!),
                  style: const TextStyle(fontSize: 11)),
          ],
        ),
        trailing: _AliveBadge(alive: session.alive),
      ),
    );
  }

  String _relativeTime(DateTime time) {
    final delta = DateTime.now().difference(time);
    if (delta.inMinutes < 1) return 'just now';
    if (delta.inMinutes < 60) return '${delta.inMinutes}m ago';
    if (delta.inHours < 24) return '${delta.inHours}h ago';
    return '${delta.inDays}d ago';
  }
}

class _AliveBadge extends StatelessWidget {
  const _AliveBadge({required this.alive});

  final bool alive;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = alive ? Colors.greenAccent : scheme.outline;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(
        alive ? 'alive' : 'stopped',
        style: TextStyle(fontSize: 11, color: color),
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
