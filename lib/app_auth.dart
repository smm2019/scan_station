part of 'main.dart';
// ===================== 账号登录 + 角色 + 服务端鉴权（App侧） =====================
// 与 server/server.js 配套：登录发 token，/api/me 心跳，停用/过期强制回登录页。
// 离线宽限：心跳遇网络错误时，凭 lastVerifiedAt 24 小时内可继续使用（缓存角色与功能开关）。

class AuthUser {
  final String id, username, name, role;
  final bool mustChangePw;
  const AuthUser({required this.id, required this.username, required this.name, required this.role, this.mustChangePw = false});
  factory AuthUser.fromJson(Map j) => AuthUser(
      id: (j["id"] ?? "").toString(), username: (j["username"] ?? "").toString(),
      name: (j["name"] ?? "").toString(), role: (j["role"] ?? "material").toString(),
      mustChangePw: j["mustChangePw"] == true);
  Map<String, dynamic> toJson() => {"id": id, "username": username, "name": name, "role": role, "mustChangePw": mustChangePw};
  String get roleName => role == "admin" ? "管理员" : (role == "warehouse" ? "仓管员" : "物料员");
}

/// 会话持久化（SharedPreferences）
class AuthStore {
  static const _kServer = "auth_server_url";
  static const _kToken = "auth_token";
  static const _kUser = "auth_user_json";
  static const _kFeatures = "auth_features_json";
  static const _kVerified = "auth_last_verified_ms";
  static const offlineGraceMs = 24 * 3600 * 1000; // 网络异常时的离线宽限期

  static Future<String> serverUrl() async => (await SharedPreferences.getInstance()).getString(_kServer) ?? "";
  static Future<void> setServerUrl(String v) async => (await SharedPreferences.getInstance()).setString(_kServer, v.trim());
  static Future<String> token() async => (await SharedPreferences.getInstance()).getString(_kToken) ?? "";
  static Future<AuthUser?> user() async {
    final s = (await SharedPreferences.getInstance()).getString(_kUser);
    if (s == null || s.isEmpty) return null;
    try { return AuthUser.fromJson(jsonDecode(s)); } catch (_) { return null; }
  }
  static Future<Map<String, bool>> features() async {
    final s = (await SharedPreferences.getInstance()).getString(_kFeatures);
    if (s == null || s.isEmpty) return {};
    try { return Map<String, bool>.from(jsonDecode(s)); } catch (_) { return {}; }
  }
  static Future<int> lastVerifiedMs() async => (await SharedPreferences.getInstance()).getInt(_kVerified) ?? 0;
  static Future<void> saveSession(String token, AuthUser u, Map features) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kToken, token);
    await sp.setString(_kUser, jsonEncode(u.toJson()));
    await sp.setString(_kFeatures, jsonEncode(Map<String, bool>.from(features)));
    await sp.setInt(_kVerified, DateTime.now().millisecondsSinceEpoch);
  }
  static Future<void> markVerified() async => (await SharedPreferences.getInstance()).setInt(_kVerified, DateTime.now().millisecondsSinceEpoch);
  static Future<void> clearSession() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken); await sp.remove(_kUser); await sp.remove(_kFeatures); await sp.remove(_kVerified);
  }
}

/// 服务端 API 封装（10 秒超时）
class AuthApi {
  static Future<Map> _req(String method, String path, {Map? body, String? token, String? serverOverride}) async {
    final base = (serverOverride ?? await AuthStore.serverUrl()).replaceFirst(RegExp(r"/+$"), "");
    if (base.isEmpty) return {"ok": false, "net": true, "msg": "未配置服务器地址"};
    final uri = Uri.parse("$base$path");
    final headers = {"Content-Type": "application/json; charset=utf-8"};
    if (token != null) headers["Authorization"] = "Bearer $token";
    try {
      late http.Response resp;
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      resp = await http.Response.fromStream(await req.send().timeout(const Duration(seconds: 10)));
      Map j;
      try { j = jsonDecode(utf8.decode(resp.bodyBytes)); } catch (_) { j = {"ok": false, "msg": "服务器返回异常(${resp.statusCode})"}; }
      j["_status"] = resp.statusCode;
      return j;
    } catch (e) {
      return {"ok": false, "net": true, "msg": "无法连接服务器：$e"};
    }
  }
  static Future<Map> login(String server, String username, String password) =>
      _req("POST", "/api/login", body: {"username": username, "password": password}, serverOverride: server);
  static Future<Map> me() async => _req("GET", "/api/me", token: await AuthStore.token());
  static Future<void> logout() async {
    final t = await AuthStore.token();
    if (t.isNotEmpty) await _req("POST", "/api/logout", token: t);
    await AuthStore.clearSession();
  }
  static Future<Map> changePassword(String oldPw, String newPw) async =>
      _req("POST", "/api/change_password", body: {"oldPassword": oldPw, "newPassword": newPw}, token: await AuthStore.token());
  static Future<Map> users() async => _req("GET", "/api/users", token: await AuthStore.token());
  static Future<Map> createUser(String username, String name, String password, String role) async =>
      _req("POST", "/api/users", body: {"username": username, "name": name, "password": password, "role": role}, token: await AuthStore.token());
  static Future<Map> updateUser(String id, Map patch) async =>
      _req("PATCH", "/api/users/$id", body: patch, token: await AuthStore.token());
  static Future<Map> deleteUser(String id) async => _req("DELETE", "/api/users/$id", token: await AuthStore.token());
  static Future<Map> config() async => _req("GET", "/api/config", token: await AuthStore.token());
  static Future<Map> setFeatures(Map features) async => _req("PATCH", "/api/config", body: {"features": features}, token: await AuthStore.token());
}

/// 全局会话（AuthGate 启动时填充；MainPage 等直接读静态成员）
class Auth {
  static AuthUser? user;
  static Map<String, bool> features = {};
  static bool get isAdmin => user?.role == "admin";
  static bool can(String feature) => user != null && (features[feature] ?? false);
}

// ===================== 启动门禁 =====================
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});
  @override
  State<AuthGate> createState() => _AuthGateState();
}
class _AuthGateState extends State<AuthGate> with WidgetsBindingObserver {
  int _stage = 0; // 0=校验中 1=需登录 2=已放行
  String _kickMsg = "";
  Timer? _beat;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }
  @override
  void dispose() { _beat?.cancel(); WidgetsBinding.instance.removeObserver(this); super.dispose(); }

  @override
  void didChangeAppLifecycleState(AppLifecycleState st) {
    if (st == AppLifecycleState.resumed && _stage == 2) _heartbeat(); // 回前台立刻校验，停用即时感知
  }

  Future<void> _bootstrap() async {
    final token = await AuthStore.token();
    final u = await AuthStore.user();
    if (token.isEmpty || u == null) { if (mounted) setState(() => _stage = 1); return; }
    final r = await AuthApi.me();
    if (!mounted) return;
    if (r["ok"] == true) {
      _apply(r);
      setState(() => _stage = 2);
      _startBeat();
    } else if (r["net"] == true) {
      // 网络异常 → 离线宽限
      final v = await AuthStore.lastVerifiedMs();
      if (DateTime.now().millisecondsSinceEpoch - v < AuthStore.offlineGraceMs) {
        Auth.user = u; Auth.features = await AuthStore.features();
        setState(() => _stage = 2);
        _startBeat();
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("离线模式：连不上鉴权服务器，24小时内暂可用"), backgroundColor: Colors.orange));
      } else { if (mounted) setState(() => _stage = 1); }
    } else {
      await AuthStore.clearSession();
      if (mounted) setState(() { _stage = 1; _kickMsg = (r["msg"] ?? "请重新登录").toString(); });
    }
  }
  void _apply(Map r) {
    Auth.user = AuthUser.fromJson(Map<String, dynamic>.from(r["user"]));
    Auth.features = Map<String, bool>.from(r["features"] ?? {});
    AuthStore.markVerified();
  }
  void _startBeat() { _beat?.cancel(); _beat = Timer.periodic(const Duration(minutes: 5), (_) => _heartbeat()); }
  Future<void> _heartbeat() async {
    final r = await AuthApi.me();
    if (!mounted) return;
    if (r["ok"] == true) { _apply(r); return; }
    if (r["net"] == true) return; // 网络抖动不踢，等宽限期
    _beat?.cancel();
    await AuthStore.clearSession();
    setState(() { _stage = 1; _kickMsg = (r["code"] == "disabled" ? "账号已被管理员停用" : "登录已过期，请重新登录").toString(); });
  }
  void _onLoggedIn() { setState(() { _stage = 2; _kickMsg = ""; }); _startBeat(); }

  @override
  Widget build(BuildContext context) {
    if (_stage == 0) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_stage == 1) return LoginPage(kickMsg: _kickMsg, onLoggedIn: _onLoggedIn);
    return MainPage(key: ValueKey(Auth.user?.id ?? "anon"));
  }
}

// ===================== 登录页 =====================
class LoginPage extends StatefulWidget {
  final String kickMsg; final VoidCallback onLoggedIn;
  const LoginPage({super.key, required this.kickMsg, required this.onLoggedIn});
  @override
  State<LoginPage> createState() => _LoginPageState();
}
class _LoginPageState extends State<LoginPage> {
  final _serverCtrl = TextEditingController();
  final _userCtrl = TextEditingController();
  final _pwCtrl = TextEditingController();
  bool _busy = false; bool _pwVisible = false;

  @override
  void initState() { super.initState(); AuthStore.serverUrl().then((v) { if (mounted && v.isNotEmpty) _serverCtrl.text = v; }); }
  @override
  void dispose() { _serverCtrl.dispose(); _userCtrl.dispose(); _pwCtrl.dispose(); super.dispose(); }

  Future<void> _login() async {
    final server = _serverCtrl.text.trim(), u = _userCtrl.text.trim(), p = _pwCtrl.text;
    if (server.isEmpty || u.isEmpty || p.isEmpty) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("服务器地址、账号、密码都要填"))); return; }
    setState(() => _busy = true);
    await AuthStore.setServerUrl(server);
    final r = await AuthApi.login(server, u, p);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r["ok"] == true) {
      await AuthStore.saveSession(r["token"], AuthUser.fromJson(Map<String, dynamic>.from(r["user"])), Map<String, dynamic>.from(r["features"] ?? {}));
      widget.onLoggedIn();
      if (Auth.user!.mustChangePw) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("首次登录，请尽快在 设置→账号与权限 修改密码"), backgroundColor: Colors.orange));
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text((r["msg"] ?? "登录失败").toString()), backgroundColor: Colors.red));
    }
  }

  InputDecoration _dec(String label, IconData icon) => InputDecoration(labelText: label, prefixIcon: Icon(icon, size: 20), border: const OutlineInputBorder(), isDense: true);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF3F4FA),
      body: SafeArea(child: Center(child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 420), child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.warehouse_outlined, size: 64, color: Color(0xFF3F51B5)),
            const SizedBox(height: 12),
            const Text("AGV货位采集器", style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            const Text("账号登录 · 权限管理", style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 24),
            if (widget.kickMsg.isNotEmpty) Container(
              width: double.infinity, margin: const EdgeInsets.only(bottom: 16), padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(8), border: Border.all(color: Colors.red.shade200)),
              child: Text(widget.kickMsg, style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
            ),
            TextField(controller: _serverCtrl, decoration: _dec("鉴权服务器（如 http://172.25.1.99:8098）", Icons.dns_outlined), keyboardType: TextInputType.url),
            const SizedBox(height: 12),
            TextField(controller: _userCtrl, decoration: _dec("账号", Icons.person_outline), textInputAction: TextInputAction.next),
            const SizedBox(height: 12),
            TextField(controller: _pwCtrl, obscureText: !_pwVisible, decoration: _dec("密码", Icons.lock_outline).copyWith(
              suffixIcon: IconButton(icon: Icon(_pwVisible ? Icons.visibility_off : Icons.visibility, size: 20), onPressed: () => setState(() => _pwVisible = !_pwVisible)))),
            const SizedBox(height: 20),
            SizedBox(width: double.infinity, height: 46, child: ElevatedButton(
              onPressed: _busy ? null : _login,
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF3F51B5), foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
              child: _busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white)) : const Text("登 录", style: TextStyle(fontSize: 16)),
            )),
          ],
        )),
      ))),
    );
  }
}

// ===================== 账号与权限（设置页入口） =====================
class AccountPage extends StatefulWidget {
  const AccountPage({super.key});
  @override
  State<AccountPage> createState() => _AccountPageState();
}
class _AccountPageState extends State<AccountPage> {
  @override
  Widget build(BuildContext context) {
    final u = Auth.user;
    if (u == null) return const Scaffold(body: Center(child: Text("未登录")));
    return Scaffold(
      appBar: AppBar(title: const Text("账号与权限")),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(child: ListTile(
            leading: CircleAvatar(backgroundColor: const Color(0xFF3F51B5).withOpacity(0.12), child: Icon(Icons.person, color: const Color(0xFF3F51B5))),
            title: Text("${u.name}（${u.username}）"),
            subtitle: Text("角色：${u.roleName} · 功能权限：${Auth.features.entries.where((e) => e.value).length} 项开启"),
          )),
          const SizedBox(height: 12),
          if (u.mustChangePw) Container(
            margin: const EdgeInsets.only(bottom: 12), padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Colors.orange.shade50, borderRadius: BorderRadius.circular(8), border: Border.all(color: Colors.orange.shade200)),
            child: const Text("首次登录建议立即修改初始密码", style: TextStyle(color: Colors.deepOrange)),
          ),
          Card(child: Column(children: [
            ListTile(leading: const Icon(Icons.password), title: const Text("修改密码"), trailing: const Icon(Icons.chevron_right),
              onTap: () => showDialog(context: context, builder: (_) => const _ChangePwDialog())),
            if (u.role == "admin") ListTile(leading: const Icon(Icons.admin_panel_settings, color: Color(0xFF3F51B5)), title: const Text("用户与功能管理（管理员）"), trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const UserManagePage()))),
          ])),
          const SizedBox(height: 12),
          Card(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(padding: EdgeInsets.fromLTRB(16, 12, 16, 4), child: Text("当前角色功能", style: TextStyle(fontWeight: FontWeight.bold))),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final e in {"collect": "采集录入", "inventory": "盘点模式", "export": "导出下载", "mes_query": "MES查询", "requisition": "领料下单", "receive_confirm": "签收确认", "admin_panel": "管理后台"}.entries)
                    Chip(
                      label: Text(e.value, style: TextStyle(fontSize: 12, color: Auth.can(e.key) ? const Color(0xFF3F51B5) : Colors.grey)),
                      backgroundColor: Auth.can(e.key) ? const Color(0xFF3F51B5).withOpacity(0.08) : Colors.grey.withOpacity(0.08),
                      side: BorderSide(color: Auth.can(e.key) ? const Color(0xFF3F51B5).withOpacity(0.4) : Colors.grey.shade300),
                    ),
                ]),
              ),
            ],
          )),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            icon: const Icon(Icons.logout, color: Colors.red), label: const Text("退出登录", style: TextStyle(color: Colors.red)),
            style: OutlinedButton.styleFrom(side: const BorderSide(color: Colors.red)),
            onPressed: () async {
              final yes = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
                title: const Text("退出登录"), content: const Text("退出后需重新输入账号密码登录。"),
                actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text("取消")), TextButton(onPressed: () => Navigator.pop(context, true), child: const Text("退出"))]));
              if (yes != true || !context.mounted) return;
              await AuthApi.logout();
              if (!context.mounted) return;
              // 清会话后重建 AuthGate：无会话自动落到登录页
              Navigator.of(context, rootNavigator: true).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const AuthGate()), (r) => false);
            },
          ),
        ],
      ),
    );
  }
}

class _ChangePwDialog extends StatefulWidget {
  const _ChangePwDialog();
  @override
  State<_ChangePwDialog> createState() => _ChangePwDialogState();
}
class _ChangePwDialogState extends State<_ChangePwDialog> {
  final _old = TextEditingController(), _new = TextEditingController(), _new2 = TextEditingController();
  bool _busy = false;
  @override
  void dispose() { _old.dispose(); _new.dispose(); _new2.dispose(); super.dispose(); }
  Future<void> _submit() async {
    if (_new.text.length < 6) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("新密码至少6位"))); return; }
    if (_new.text != _new2.text) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("两次输入的新密码不一致"))); return; }
    setState(() => _busy = true);
    final r = await AuthApi.changePassword(_old.text, _new.text);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text((r["msg"] ?? (r["ok"] == true ? "密码已修改" : "修改失败")).toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    if (r["ok"] == true) Navigator.pop(context);
  }
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text("修改密码"),
      content: SizedBox(width: 320, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: _old, obscureText: true, decoration: const InputDecoration(labelText: "原密码", isDense: true, border: OutlineInputBorder())),
        const SizedBox(height: 10),
        TextField(controller: _new, obscureText: true, decoration: const InputDecoration(labelText: "新密码（≥6位）", isDense: true, border: OutlineInputBorder())),
        const SizedBox(height: 10),
        TextField(controller: _new2, obscureText: true, decoration: const InputDecoration(labelText: "确认新密码", isDense: true, border: OutlineInputBorder())),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text("取消")),
        ElevatedButton(onPressed: _busy ? null : _submit, child: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text("确定"))],
    );
  }
}

// ===================== 管理员：用户与功能管理 =====================
class UserManagePage extends StatefulWidget {
  const UserManagePage({super.key});
  @override
  State<UserManagePage> createState() => _UserManagePageState();
}
class _UserManagePageState extends State<UserManagePage> {
  List _users = [];
  Map _features = {};
  Map _featureNames = const {};
  bool _loading = true; String _err = "";

  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
    final ru = await AuthApi.users();
    final rc = await AuthApi.config();
    if (!mounted) return;
    if (ru["ok"] != true) { setState(() { _loading = false; _err = (ru["msg"] ?? "加载失败").toString(); }); return; }
    _users = List.from(ru["users"]);
    if (rc["ok"] == true) { _features = Map.from(rc["features"]); _featureNames = Map.from(rc["featureNames"] ?? {}); }
    setState(() => _loading = false);
  }

  Future<void> _addUser() async {
    final uname = TextEditingController(), name = TextEditingController(), pw = TextEditingController();
    String role = "material";
    final ok = await showDialog<bool>(context: context, builder: (_) => StatefulBuilder(builder: (ctx, setS) => AlertDialog(
      title: const Text("新建账号"),
      content: SizedBox(width: 320, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: uname, decoration: const InputDecoration(labelText: "登录账号（字母数字3-20位）", isDense: true, border: OutlineInputBorder())),
        const SizedBox(height: 8),
        TextField(controller: name, decoration: const InputDecoration(labelText: "姓名", isDense: true, border: OutlineInputBorder())),
        const SizedBox(height: 8),
        TextField(controller: pw, decoration: const InputDecoration(labelText: "初始密码（≥6位）", isDense: true, border: OutlineInputBorder())),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(value: role, decoration: const InputDecoration(labelText: "角色", isDense: true, border: OutlineInputBorder()),
          items: const [DropdownMenuItem(value: "material", child: Text("物料员")), DropdownMenuItem(value: "warehouse", child: Text("仓管员")), DropdownMenuItem(value: "admin", child: Text("管理员"))],
          onChanged: (v) => setS(() => role = v ?? "material")),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("创建"))],
    )));
    if (ok != true || !mounted) return;
    final r = await AuthApi.createUser(uname.text.trim(), name.text.trim(), pw.text, role);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text((r["msg"] ?? (r["ok"] == true ? "已创建" : "失败")).toString()), backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    uname.dispose(); name.dispose(); pw.dispose();
    _load();
  }

  Future<void> _toggleEnabled(Map u) async {
    final r = await AuthApi.updateUser(u["id"], {"enabled": !(u["enabled"] == true)});
    if (r["ok"] != true && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text((r["msg"] ?? "操作失败").toString()), backgroundColor: Colors.red));
    _load();
  }
  Future<void> _resetPw(Map u) async {
    final pw = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text("重置 ${u["username"]} 的密码"),
      content: SizedBox(width: 280, child: TextField(controller: pw, decoration: const InputDecoration(labelText: "新密码（≥6位）", isDense: true, border: OutlineInputBorder()))),
      actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text("取消")), ElevatedButton(onPressed: () => Navigator.pop(context, true), child: const Text("重置"))],
    ));
    if (ok == true && pw.text.length >= 6) await AuthApi.updateUser(u["id"], {"password": pw.text});
    pw.dispose(); _load();
  }

  Future<void> _editFeatures() async {
    final copy = <String, Map<String, bool>>{};
    for (final e in _features.entries) { copy[e.key] = Map<String, bool>.from(e.value); }
    await showModalBottomSheet(context: context, isScrollControlled: true, builder: (ctx) => StatefulBuilder(builder: (ctx, setS) {
      const roleNames = {"material": "物料员", "warehouse": "仓管员", "admin": "管理员"};
      return Padding(padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16), child: SizedBox(
        height: 460, width: double.infinity,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text("功能开关（保存后各端心跳刷新，最迟5分钟生效）", style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Expanded(child: SingleChildScrollView(child: Column(children: [
            for (final role in copy.keys) Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(roleNames[role] ?? role, style: const TextStyle(fontWeight: FontWeight.bold)),
              for (final f in copy[role]!.keys) SwitchListTile(
                dense: true, contentPadding: EdgeInsets.zero, title: Text(_featureNames[f]?.toString() ?? f, style: const TextStyle(fontSize: 14)),
                value: copy[role]![f] ?? false,
                onChanged: (v) => setS(() => copy[role]![f] = v),
              ),
            ]))),
          ]))),
          const SizedBox(height: 8),
          Row(children: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
            const Spacer(),
            ElevatedButton(onPressed: () async {
              final r = await AuthApi.setFeatures(copy);
              if (ctx.mounted) { Navigator.pop(ctx); ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text((r["msg"] ?? (r["ok"] == true ? "已保存" : "保存失败")).toString()), backgroundColor: r["ok"] == true ? Colors.green : Colors.red)); }
              _load();
            }, child: const Text("保存")),
          ]),
        ]),
      ));
    }));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("用户与功能管理"), actions: [
        IconButton(icon: const Icon(Icons.tune), tooltip: "功能开关", onPressed: _features.isEmpty ? null : _editFeatures),
        IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
      ]),
      floatingActionButton: FloatingActionButton.extended(onPressed: _addUser, icon: const Icon(Icons.person_add), label: const Text("新建账号")),
      body: _loading ? const Center(child: CircularProgressIndicator()) : (_err.isNotEmpty
          ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
          : ListView(children: [
              for (final u in _users) Card(child: ListTile(
                leading: CircleAvatar(backgroundColor: (u["enabled"] == true ? Colors.green : Colors.grey).withOpacity(0.15),
                    child: Icon(u["enabled"] == true ? Icons.check : Icons.block, color: u["enabled"] == true ? Colors.green : Colors.grey, size: 20)),
                title: Text("${u["name"]}（${u["username"]}）"),
                subtitle: Text("角色：${{"material": "物料员", "warehouse": "仓管员", "admin": "管理员"}[u["role"]] ?? u["role"]}${u["enabled"] == true ? "" : " · 已停用"}"),
                trailing: PopupMenuButton<String>(onSelected: (v) {
                  if (v == "toggle") _toggleEnabled(Map.from(u));
                  if (v == "pw") _resetPw(Map.from(u));
                  if (v == "del") showDialog(context: context, builder: (_) => AlertDialog(
                    title: Text("删除 ${u["username"]}？"), content: const Text("删除后该账号立即失效且不可恢复。"),
                    actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text("取消")),
                      TextButton(onPressed: () async { await AuthApi.deleteUser(u["id"]); if (context.mounted) Navigator.pop(context); _load(); }, child: const Text("删除", style: TextStyle(color: Colors.red)))]));
                }, itemBuilder: (_) => const [
                  PopupMenuItem(value: "toggle", child: Text("启用/停用")),
                  PopupMenuItem(value: "pw", child: Text("重置密码")),
                  PopupMenuItem(value: "del", child: Text("删除账号")),
                ]),
              )),
            ])),
    );
  }
}
