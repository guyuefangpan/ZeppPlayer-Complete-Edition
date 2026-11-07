package com.zeppplayer.mobile;

import java.util.HashMap;
import java.util.Map;

/* Tiny JSON helper: the front-end only sends flat objects of strings, so a
 * full parser is not needed and keeps the APK free of extra dependencies. */
final class Json {
    private Json() {}

    static String str(String value) {
        if (value == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    static String obj(String... kv) {
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (i > 0) sb.append(',');
            sb.append(str(kv[i])).append(':').append(kv[i + 1]);
        }
        return sb.append('}').toString();
    }

    static Map<String, String> parseObject(String src) {
        Map<String, String> out = new HashMap<String, String>();
        if (src == null) return out;
        int[] pos = {0};
        skipWs(src, pos);
        if (pos[0] >= src.length() || src.charAt(pos[0]) != '{') return out;
        pos[0]++;
        while (pos[0] < src.length()) {
            skipWs(src, pos);
            if (pos[0] >= src.length()) break;
            char c = src.charAt(pos[0]);
            if (c == '}') { pos[0]++; break; }
            if (c == ',') { pos[0]++; continue; }
            String key = readString(src, pos);
            skipWs(src, pos);
            if (pos[0] >= src.length() || src.charAt(pos[0]) != ':') break;
            pos[0]++;
            skipWs(src, pos);
            String value;
            if (pos[0] < src.length() && src.charAt(pos[0]) == '"') {
                value = readString(src, pos);
            } else {
                value = readBare(src, pos);
            }
            if (key != null) out.put(key, value);
            skipWs(src, pos);
        }
        return out;
    }

    private static void skipWs(String s, int[] pos) {
        while (pos[0] < s.length()) {
            char c = s.charAt(pos[0]);
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') pos[0]++;
            else break;
        }
    }

    private static String readString(String s, int[] pos) {
        if (pos[0] >= s.length() || s.charAt(pos[0]) != '"') return null;
        pos[0]++;
        StringBuilder sb = new StringBuilder();
        while (pos[0] < s.length()) {
            char c = s.charAt(pos[0]++);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            if (pos[0] >= s.length()) break;
            char e = s.charAt(pos[0]++);
            switch (e) {
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u':
                    if (pos[0] + 4 <= s.length()) {
                        try {
                            sb.append((char) Integer.parseInt(s.substring(pos[0], pos[0] + 4), 16));
                        } catch (NumberFormatException ignored) {}
                        pos[0] += 4;
                    }
                    break;
                default: sb.append(e);
            }
        }
        return sb.toString();
    }

    private static String readBare(String s, int[] pos) {
        int start = pos[0];
        while (pos[0] < s.length()) {
            char c = s.charAt(pos[0]);
            if (c == ',' || c == '}' || c == ' ' || c == '\n' || c == '\r' || c == '\t') break;
            pos[0]++;
        }
        return s.substring(start, pos[0]);
    }
}
