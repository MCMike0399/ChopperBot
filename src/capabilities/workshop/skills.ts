/** Curated, on-demand recipes. Kept out of the base prompt to preserve turn budget. */
export const WORKSHOP_SKILLS = {
   docx: `# Word: documentos editables y legibles
Lee primero el archivo original y conserva hechos, fechas, nombres y restricciones; no inventes credenciales ni resultados. Si corriges, guarda una versión nueva. Usa estilos reales (Title, Heading 1/2, Normal) en vez de simular encabezados con negritas. Define márgenes, fuente y espaciado; respeta el formato solicitado. Tablas con encabezados, anchos que sumen el área útil y texto ajustado; evita celdas y párrafos gigantes. Encabezados con keep_with_next; no mantengas toda una sección junta si crea páginas vacías. Para CV: una columna, contacto como texto, sin iconos, no prometas una página sin medirla.
Ejemplo mínimo ejecutable:
\`\`\`python
from docx import Document
from docx.shared import Cm, Pt
from docx.oxml import OxmlElement
doc = Document()
section = doc.sections[0]
section.top_margin = section.bottom_margin = Cm(2)
section.left_margin = section.right_margin = Cm(2)
doc.styles['Normal'].font.name = 'DejaVu Sans'
doc.styles['Normal'].font.size = Pt(11)
doc.add_heading('Guía de estudio', 0)
doc.add_heading('Objetivo', 1)
doc.add_paragraph('Identificar el concepto y aplicarlo a un caso propio.')
t = doc.add_table(rows=1, cols=2)
t.style = 'Table Grid'
for c, text in zip(t.rows[0].cells, ['Concepto', 'Ejemplo']): c.text = text
repeat = OxmlElement('w:tblHeader')
t.rows[0]._tr.get_or_add_trPr().append(repeat)
for c, text in zip(t.add_row().cells, ['Indicador', 'Tiempo de respuesta']): c.text = text
doc.save('guia.docx')
\`\`\`
Reabre con Document('guia.docx'); verifica secciones, tablas y figuras. Usa workshop_check_file. Si necesitas medir páginas o entregar PDF, convierte con LibreOffice según la receta pdf; no generes un segundo texto diferente. Fuentes: https://python-docx.readthedocs.io/en/latest/user/quickstart.html`,
   xlsx: `# Excel: modelos que se pueden usar y comprobar
Separa entradas, cálculos y explicación; identifica unidades, supuestos y celdas editables. Preserva los datos originales. Usa encabezados, filtros, paneles congelados, ajuste de texto, anchos y formatos numéricos (porcentaje, fecha, moneda). No unas celdas en el rango de datos. Añade validación donde corresponda. Evita interpretar entradas de texto del usuario que empiezan por = como fórmulas.
Para dinero usa centavos enteros o Decimal y verifica que aportaciones - gasto = cambio y que la suma del reparto coincide exactamente. No asumas quién aportó qué: pide el dato crítico o marca explícitamente el escenario.
Ejemplo mínimo ejecutable:
\`\`\`python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.properties import CalcProperties
wb = Workbook()
ws = wb.active
ws.title = 'Presupuesto'
ws.append(['Concepto', 'Cantidad', 'Precio', 'Importe'])
ws.append(['Material', 3, 25, '=B2*C2'])
ws.append(['Total', None, None, '=SUM(D2:D2)'])
for c in ws[1]:
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor='245A81')
ws.freeze_panes = 'B2'
ws.auto_filter.ref = 'A1:D2'
for col in 'ABCD': ws.column_dimensions[col].width = 20
for row in ws:
    for c in row: c.alignment = Alignment(wrap_text=True, vertical='top')
for row in range(2, 4): ws.cell(row, 4).number_format = '#,##0.00'
dv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1=0)
dv.errorTitle = 'Valor no válido'; dv.error = 'Escribe un número no negativo.'; dv.showErrorMessage = True
ws.add_data_validation(dv); dv.add('B2:C2')
wb.calculation = CalcProperties(calcId=0, fullCalcOnLoad=True)
wb.save('presupuesto.xlsx')
assert 3 * 25 == 75
assert load_workbook('presupuesto.xlsx')['Presupuesto']['D2'].value == '=B2*C2'
\`\`\`
openpyxl NO calcula fórmulas. data_only=True lee valores guardados, no verifica el cálculo. Para obtener valores de vista previa, recalcula una copia con LibreOffice (receta pdf, --convert-to xlsx --outdir en otro directorio), reabre con data_only=True y compara con cuentas independientes de Python; conserva fórmulas. Si no puedes recalcular, dilo: se calcularán al abrir en Excel/Calc. No afirmes que comprobaste resultados por haber guardado el libro. Ejecuta workshop_check_file.
Fuente: https://openpyxl.readthedocs.io/en/stable/simple_formulae.html`,
   pptx: `# PowerPoint: diapositivas para exponer
Define audiencia, tiempo y mensaje central. Usa formato panorámico, un mensaje por diapositiva, título informativo y pocas líneas. Cuerpo de 20–24 pt o más, títulos de 30–36 pt; evita reducir letra para meter un ensayo. Si no cabe, divide la diapositiva. Márgenes y contraste consistentes; imágenes con proporción conservada y fuentes en notas o una diapositiva final. Usa gráficos y texto editables cuando se pueda. No inventes evidencia ni fotografías.
Ejemplo mínimo ejecutable:
\`\`\`python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[6])
for text, y, size in [('Medir para decidir', 0.6, 34), ('Indicador: lo que medimos.\\nMeta: el valor que queremos alcanzar.', 1.8, 24)]:
    box = slide.shapes.add_textbox(Inches(0.7), Inches(y), Inches(11.9), Inches(1.8))
    tf = box.text_frame
    tf.word_wrap = True
    tf.text = text
    for p in tf.paragraphs:
        p.font.name = 'DejaVu Sans'
        p.font.size = Pt(size)
slide.notes_slide.notes_text_frame.text = 'Explicar con un ejemplo del curso, sin confundir indicador y meta.'
prs.save('presentacion.pptx')
\`\`\`
Verifica límites de todas las formas, cantidad de texto y tamaño de letra. fit_text puede requerir un archivo de fuente instalado; no dependas de Calibri. Usa workshop_check_file y convierte una copia a PDF para medir páginas y revisar distribución con la receta pdf. El chequeo estructural no garantiza que no haya texto desbordado.
Fuente: https://python-pptx.readthedocs.io/en/latest/user/text.html`,
   pdf: `# PDF: lectura, conversión y composición
Para leer documentos largos usa el índice; para tablas usa pdfplumber. Para crear, usa reportlab.platypus (Paragraph, Spacer, Table, PageBreak), no coordenadas manuales para párrafos largos. Escapa texto con xml.sax.saxutils.escape antes de pasarlo a Paragraph. Tablas: Paragraph dentro de celdas, anchos dentro del área útil, encabezado repetido (repeatRows=1), padding y alineación arriba. No metas un libro entero en una celda.
Ejemplo mínimo ejecutable:
\`\`\`python
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from xml.sax.saxutils import escape
pdfmetrics.registerFont(TTFont('DejaVu', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
styles = getSampleStyleSheet()
for s in styles.byName.values(): s.fontName = 'DejaVu'
doc = SimpleDocTemplate('guia.pdf', leftMargin=42, rightMargin=42, topMargin=42, bottomMargin=42)
para = lambda t: Paragraph(escape(t), styles['BodyText'])
rows = [[para(t) for t in row] for row in [['Concepto', 'Ejemplo'], ['Indicador', 'Tiempo de respuesta']]]
t = Table(rows, colWidths=[doc.width * 0.4, doc.width * 0.6], repeatRows=1)
t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#EAF1F8')), ('VALIGN',(0,0),(-1,-1),'TOP'), ('BOTTOMPADDING',(0,0),(-1,-1),8)]))
doc.build([Paragraph('Guía', styles['Title']), Spacer(1,12), t])
\`\`\`
Si ya existe Word o PowerPoint y se pide PDF, convierte ESE archivo para conservar el contenido. LibreOffice puede usarse desde el sandbox, sin red y con perfil temporal propio:
\`\`\`python
import subprocess
from pathlib import Path
Path('vista_previa').mkdir(exist_ok=True)
r = subprocess.run(['libreoffice', '-env:UserInstallation=file:///tmp/lo-taller', '--headless', '--convert-to', 'pdf', '--outdir', 'vista_previa', 'guia.docx'], capture_output=True, text=True, timeout=45)
assert r.returncode == 0, r.stderr
assert Path('vista_previa/guia.pdf').is_file(), r.stdout
\`\`\`
Después usa pypdf.PdfReader para contar páginas y verificar texto. Para revisión visual puedes producir PNG con pdftoppm -scale-to 1400 -png; eso genera una imagen, NO demuestra por sí mismo que revisaste el diseño. Ejecuta workshop_check_file sobre el PDF y explica límites reales. Si la conversión falla dos veces, entrega el original editable y explica qué falta; no lo reconstruyas perdiendo contenido.
Fuentes: https://docs.reportlab.com/reportlab/userguide/ch7_tables/ ; https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html`,
   plots: `# Gráficas reproducibles para estudiar y trabajar
Define qué pregunta responde cada gráfica y de dónde salen los datos. Distingue mediciones, simulación y ejemplo; declara unidades, condiciones iniciales, método, paso temporal y límites. No extrapoles una curva simulada como evidencia experimental. Usa semillas cuando haya azar, etiquetas en español con unidades, leyenda si ayuda, contraste y tamaño de letra legibles; evita recortar etiquetas.
Ejemplo mínimo ejecutable:
\`\`\`python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
x = np.linspace(0, 10, 200)
y = np.exp(-x / 3)
fig, ax = plt.subplots(figsize=(8, 4.5), constrained_layout=True)
ax.plot(x, y, label='Modelo: exp(-t/3)')
ax.set(xlabel='Tiempo (s)', ylabel='Amplitud (u. a.)', title='Decaimiento simulado')
ax.legend(); ax.grid(alpha=0.25)
fig.savefig('grafica.png', dpi=180, bbox_inches='tight')
plt.close(fig)
np.savetxt('datos.csv', np.c_[x,y], delimiter=',', header='tiempo_s,amplitud', comments='')
assert np.isfinite(y).all() and np.all(np.diff(y) <= 0)
\`\`\`
Para análisis numérico imprime comprobaciones independientes (dimensiones, valores finitos, error o convergencia cuando aplique). Guarda también el script completo como archivo .py con workshop_write_file y envíalo junto al PNG y los datos si el usuario quiere reproducir o modificar el trabajo. Al integrar una figura en Word/PPT, conserva proporción y añade pie explicativo. Usa workshop_check_file. No confundas una simulación que corre con un resultado científicamente validado.
Fuente: https://matplotlib.org/stable/users/explain/figure/backends.html`,
} as const;

export type WorkshopSkill = keyof typeof WORKSHOP_SKILLS;
