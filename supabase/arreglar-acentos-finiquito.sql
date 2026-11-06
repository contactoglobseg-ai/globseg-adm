
-- Arreglar los acentos de la plantilla del finiquito.
--
-- Este archivo NO TIENE NI UN CARACTER ACENTUADO. El texto va en base64, que
-- es ASCII puro, y Postgres lo decodifica con convert_from(). Da lo mismo con
-- que programa se copie y pegue: el portapapeles no puede romper ASCII.
--
-- Hace falta porque `pbcopy` en el Mac de la oficina corre sin locale UTF-8 y
-- lee los bytes como MacRoman, asi que la migracion entro con
-- "RATIFICACI(basura)N" adentro y quedo grabada asi. El texto de una plantilla
-- es lo que se imprime en un documento que se firma.
--
-- No toca nada mas: una sola fila de plantillas_documento. Se puede correr las
-- veces que sea.

update plantillas_documento set
  nombre        = convert_from(decode('RmluaXF1aXRvIGRlIGNvbnRyYXRvIGRlIHRyYWJham8=', 'base64'), 'UTF8'),
  titulo        = convert_from(decode('RklOSVFVSVRPIERFIENPTlRSQVRPIERFIFRSQUJBSk8=', 'base64'), 'UTF8'),
  por_confirmar = convert_from(decode(
    'TGFzIHN1bWFzIHNhbGVuIGRlbCBjw6FsY3VsbyBkZWwgc2lzdGVtYSwgcXVlIGNvbm9jZSBsYSBp'
    'bmRlbW5pemFjacOzbiBwb3IgYcOxb3MgZGUgc2VydmljaW8sIGVsIG1lcyBkZSBhdmlzbyB5IGVs'
    'IGZlcmlhZG8gcGVuZGllbnRlLiBObyBjb25vY2UgbGEgcmVtdW5lcmFjacOzbiBkZSBsb3MgZMOt'
    'YXMgdHJhYmFqYWRvcyBkZWwgw7psdGltbyBtZXMsIGxhcyBob3JhcyBleHRyYW9yZGluYXJpYXMs'
    'IGxvcyBib25vcyBkZWwgbWVzIG5pIGxvcyBhbnRpY2lwb3M6IHNpIGNvcnJlc3BvbmRlbiwgYWdy'
    'w6lndWVsb3MgYWJham8gYW50ZXMgZGUgZ2VuZXJhci4gUmV2aXNlIGFkZW3DoXMgcXVlIGxhcyBj'
    'b3RpemFjaW9uZXMgZXN0w6luIHBhZ2FkYXMgaGFzdGEgZWwgbWVzIHF1ZSBzZSBkZWNsYXJhLg=='
    , 'base64'), 'UTF8'),
  cuerpo        = convert_from(decode(
    'RW4ge3tjaXVkYWR9fSwgYSB7e2ZlY2hhX2NvbnRyYXRvfX0sIGVudHJlIHt7cmF6b25fc29jaWFs'
    'fX0sIFJVVCBOwrAge3tlbXByZXNhX3J1dH19LCBlbiBhZGVsYW50ZSAiZWwgRW1wbGVhZG9yIiwg'
    'cmVwcmVzZW50YWRhIHBvciBkb24ge3tyZXByZXNlbnRhbnRlfX0sIGPDqWR1bGEgbmFjaW9uYWwg'
    'ZGUgaWRlbnRpZGFkIE4uwroge3tyZXByZXNlbnRhbnRlX3J1dH19LCBhbWJvcyBkb21pY2lsaWFk'
    'b3MgZW4ge3tlbXByZXNhX2RvbWljaWxpb319LCBwb3IgdW5hIHBhcnRlOyB5IHBvciBsYSBvdHJh'
    'LCBkb24ow7FhKSB7e3RyYWJhamFkb3J9fSwgY8OpZHVsYSBuYWNpb25hbCBkZSBpZGVudGlkYWQg'
    'Ti7CuiB7e3J1dH19LCBkb21pY2lsaWFkbyhhKSBlbiB7e2RvbWljaWxpb319LCBjb211bmEgZGUg'
    'e3tjb211bmF9fSwgZW4gYWRlbGFudGUgImVsL2xhIHRyYWJhamFkb3IvYSIsIHNlIGRlamEgY29u'
    'c3RhbmNpYSBkZWwgc2lndWllbnRlIGZpbmlxdWl0byBkZSBjb250cmF0byBkZSB0cmFiYWpvOgoK'
    'e3tufX0uLSBERSBMQSBSRUxBQ0nDk04gTEFCT1JBTC4gRWwvbGEgdHJhYmFqYWRvci9hIHByZXN0'
    'w7Mgc2VydmljaW9zIHBhcmEgZWwgRW1wbGVhZG9yIGRlc2RlIGVsIHt7ZmVjaGFfaW5ncmVzb319'
    'LCBkZXNlbXBlw7FhbmRvIGVsIGNhcmdvIGRlIHt7Y2FyZ299fXt7I2x1Z2FyX3RyYWJham99fSwg'
    'ZW4ge3tsdWdhcl90cmFiYWpvfX17ey9sdWdhcl90cmFiYWpvfX0sIGVuIHZpcnR1ZCBkZWwgY29u'
    'dHJhdG8gaW5kaXZpZHVhbCBkZSB0cmFiYWpvIHN1c2NyaXRvIGVudHJlIGxhcyBwYXJ0ZXN7eyNj'
    'b250cmF0b19kZXNkZX19IGNvbiBmZWNoYSB7e2NvbnRyYXRvX2Rlc2RlfX17ey9jb250cmF0b19k'
    'ZXNkZX19LgoKe3tufX0uLSBERUwgVMOJUk1JTk8uIExhIHJlbGFjacOzbiBsYWJvcmFsIHRlcm1p'
    'bsOzIGNvbiBmZWNoYSB7e2ZlY2hhX3Rlcm1pbm99fSwgcG9yIGxhIGNhdXNhbCBjb250ZW1wbGFk'
    'YSBlbiBlbCB7e2NhdXNhbF90ZXh0b319Lnt7I2NhdXNhbF9kZXRhbGxlfX0gTG9zIGhlY2hvcyBl'
    'biBxdWUgc2UgZnVuZGEgbGEgY2F1c2FsIHNvbiBsb3Mgc2lndWllbnRlczoge3tjYXVzYWxfZGV0'
    'YWxsZX19e3svY2F1c2FsX2RldGFsbGV9fSBBIGxhIGZlY2hhIGRlIHTDqXJtaW5vLCBlbC9sYSB0'
    'cmFiYWphZG9yL2EgcmVnaXN0cmEgdW5hIGFudGlnw7xlZGFkIGRlIHt7YW50aWd1ZWRhZH19LgoK'
    'e3tufX0uLSBERSBMQVMgU1VNQVMgUVVFIFNFIFBBR0FOLiBFbCBFbXBsZWFkb3IgcGFnYSBlbiBl'
    'c3RlIGFjdG8gYWwgdHJhYmFqYWRvci9hLCB5IMOpc3RlL2EgZGVjbGFyYSByZWNpYmlyIGEgc3Ug'
    'ZW50ZXJhIHNhdGlzZmFjY2nDs24sIGxhcyBzaWd1aWVudGVzIHN1bWFzIHBvciBsb3MgY29uY2Vw'
    'dG9zIHF1ZSBzZSBpbmRpY2FuOgoKe3tkZXRhbGxlX3BhZ29zfX0KCnt7I2RldGFsbGVfZGVzY3Vl'
    'bnRvc319RGUgbGFzIHN1bWFzIGFudGVyaW9yZXMgc2UgZGVkdWNlbiBsb3Mgc2lndWllbnRlcyBj'
    'b25jZXB0b3MsIHF1ZSBlbC9sYSB0cmFiYWphZG9yL2EgYWNlcHRhIGV4cHJlc2FtZW50ZToKCnt7'
    'ZGV0YWxsZV9kZXNjdWVudG9zfX0KCnt7L2RldGFsbGVfZGVzY3VlbnRvc319RWwgdG90YWwgbMOt'
    'cXVpZG8gcXVlIGVsL2xhIHRyYWJhamFkb3IvYSByZWNpYmUgZW4gZXN0ZSBhY3RvIGFzY2llbmRl'
    'IGEgbGEgc3VtYSBkZSAkIHt7dG90YWx9fSAoe3t0b3RhbF9wYWxhYnJhc319KS4KCnt7bn19Li0g'
    'REUgTEEgRk9STUEgREUgUEFHTy4ge3tmb3JtYV9wYWdvfX0gTGFzIHBhcnRlcyBkZWphbiBjb25z'
    'dGFuY2lhIGRlIHF1ZSBlbCBmaW5pcXVpdG8gZGViZSBzZXIgcGFnYWRvIGRlbnRybyBkZSBsb3Mg'
    'ZGlleiBkw61hcyBow6FiaWxlcyBzaWd1aWVudGVzIGEgbGEgc2VwYXJhY2nDs24gZGVsIHRyYWJh'
    'amFkb3IsIGNvbmZvcm1lIGFsIGluY2lzbyBmaW5hbCBkZWwgYXJ0w61jdWxvIDE3NyBkZWwgQ8Oz'
    'ZGlnbyBkZWwgVHJhYmFqby4KCnt7bn19Li0gREUgTEFTIENPVElaQUNJT05FUyBQUkVWSVNJT05B'
    'TEVTLiBFbCBFbXBsZWFkb3IgZGVjbGFyYSBxdWUgbGFzIGNvdGl6YWNpb25lcyBwcmV2aXNpb25h'
    'bGVzLCBkZSBzYWx1ZCB5IGRlIHNlZ3VybyBkZSBjZXNhbnTDrWEgZGVsL2xhIHRyYWJhamFkb3Iv'
    'YSBzZSBlbmN1ZW50cmFuIMOtbnRlZ3JhbWVudGUgZGVjbGFyYWRhcyB5IHBhZ2FkYXMgaGFzdGEg'
    'e3tjb3RpemFjaW9uZXNfaGFzdGF9fSwgY29uZm9ybWUgYSBsbyBkaXNwdWVzdG8gZW4gZWwgaW5j'
    'aXNvIHF1aW50byBkZWwgYXJ0w61jdWxvIDE2MiBkZWwgQ8OzZGlnbyBkZWwgVHJhYmFqbywgeSBh'
    'Y29tcGHDsWEgZW4gZXN0ZSBhY3RvIGxvcyBjb21wcm9iYW50ZXMgcXVlIGFzw60gbG8gYWNyZWRp'
    'dGFuLgoKe3tufX0uLSBERSBMQSBERUNMQVJBQ0nDk04gREVMIFRSQUJBSkFET1IuIEVsL2xhIHRy'
    'YWJhamFkb3IvYSBkZWNsYXJhIHF1ZSwgcGFnYWRhcyBsYXMgc3VtYXMgaW5kaWNhZGFzIGVuIGVz'
    'dGUgaW5zdHJ1bWVudG8sIG5vIHRpZW5lIGNhcmdvIG5pIGNvYnJvIGFsZ3VubyBxdWUgZm9ybXVs'
    'YXIgZW4gY29udHJhIGRlbCBFbXBsZWFkb3IgcG9yIGNvbmNlcHRvIGRlIHJlbXVuZXJhY2lvbmVz'
    'LCBzb2JyZXN1ZWxkb3MsIGhvcmFzIGV4dHJhb3JkaW5hcmlhcywgZmVyaWFkb3MgbGVnYWxlcyBv'
    'IHByb3BvcmNpb25hbGVzLCBncmF0aWZpY2FjaW9uZXMsIGFzaWduYWNpb25lcywgaW5kZW1uaXph'
    'Y2lvbmVzLCBjb3RpemFjaW9uZXMgZGUgc2VndXJpZGFkIHNvY2lhbCwgbmkgcG9yIG5pbmfDum4g'
    'b3RybyBjb25jZXB0byBkZXJpdmFkbyBkZSBsYSByZWxhY2nDs24gbGFib3JhbCBxdWUgbG9zIHVu'
    'acOzIG8gZGUgc3UgdMOpcm1pbm8sIG90b3Jnw6FuZG9sZSBlbiBjb25zZWN1ZW5jaWEgZWwgbcOh'
    'cyBhbXBsaW8geSB0b3RhbCBmaW5pcXVpdG8uCgp7eyNyZXNlcnZhfX17e259fS4tIERFIExBIFJF'
    'U0VSVkEgREUgREVSRUNIT1MuIFNpbiBwZXJqdWljaW8gZGUgbG8gc2XDsWFsYWRvIGVuIGxhIGNs'
    'w6F1c3VsYSBhbnRlcmlvciwgZWwvbGEgdHJhYmFqYWRvci9hIGZvcm11bGEgZXhwcmVzYSByZXNl'
    'cnZhIGRlIGRlcmVjaG9zIHJlc3BlY3RvIGRlIGxvIHNpZ3VpZW50ZToge3tyZXNlcnZhfX0KCnt7'
    'L3Jlc2VydmF9fXt7bn19Li0gREUgTEEgUkFUSUZJQ0FDScOTTi4gTGFzIHBhcnRlcyBkZWphbiBj'
    'b25zdGFuY2lhIGRlIHF1ZSBlc3RlIGluc3RydW1lbnRvIHNlIHN1c2NyaWJlIG1lZGlhbnRlIGZp'
    'cm1hIGVsZWN0csOzbmljYSBzaW1wbGUsIGNvbmZvcm1lIGEgbGEgTGV5IDE5Ljc5OSwgeSBkZSBx'
    'dWUgZGViZXLDoSBzZXIgcmF0aWZpY2FkbyBhbnRlIGFsZ3VubyBkZSBsb3MgbWluaXN0cm9zIGRl'
    'IGZlIHF1ZSBzZcOxYWxhIGVsIGFydMOtY3VsbyAxNzcgZGVsIEPDs2RpZ28gZGVsIFRyYWJham8u'
    'IE1pZW50cmFzIG5vIHNlYSByYXRpZmljYWRvLCBlbCBlbXBsZWFkb3Igbm8gcG9kcsOhIGludm9j'
    'YXJsby4gU2UgZXh0aWVuZGUgZW4gZG9zIGVqZW1wbGFyZXMgZGUgaWd1YWwgdGVub3IgeSBmZWNo'
    'YSwgZGVjbGFyYW5kbyBlbC9sYSB0cmFiYWphZG9yL2EgcmVjaWJpciB1bm8gZGUgZWxsb3Mu'
    , 'base64'), 'UTF8')
 where codigo = 'finiquito';

-- La comprobacion. Las dos primeras columnas tienen que decir true.
-- Los caracteres tambien van en base64, por lo mismo: chr() depende de la
-- codificacion de la base y en una que no sea UTF8 revienta.
select
  position(convert_from(decode('UkFUSUZJQ0FDScOTTg==', 'base64'), 'UTF8')
           in cuerpo) > 0                      as acentos_buenos,
  position(convert_from(decode('4oia', 'base64'), 'UTF8')
           in cuerpo) = 0                      as sin_basura,
  length(cuerpo)                               as largo_del_texto
  from plantillas_documento
 where codigo = 'finiquito';
