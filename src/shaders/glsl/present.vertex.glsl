in vec2 a_pos;
out vec2 v_texture_pos;

void main() {
    v_texture_pos = a_pos;
    gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
