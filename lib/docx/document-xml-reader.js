exports.DocumentXmlReader = DocumentXmlReader;

var _ = require("underscore");

var documents = require("../documents");
var Result = require("../results").Result;
var warning = require("../results").warning;


function DocumentXmlReader(options) {
    var relationships = options.relationships;
    var contentTypes = options.contentTypes;
    var docxFile = options.docxFile;
    var numbering = options.numbering;
    var styles = options.styles;
    var rawFootnotes = options.footnotes || [];
    
    
    function convertXmlToDocument(documentXml) {
        var body = documentXml.root.first("w:body");
        
        var result = readXmlElements(body.children)
            .flatMap(function(children) {
                return readFootnotes().map(function(footnotes) {
                    return new documents.Document(children, {footnotes: footnotes});
                });
            });
        result.document = result.value;
        return result;
    }
    
    function readFootnotes() {
        return Result.combine(rawFootnotes.map(function(rawFootnote) {
            return readXmlElements(rawFootnote.body).map(function(body) {
                return new documents.Footnote({
                    id: rawFootnote.id,
                    body: body
                });
            });
        })).map(function(footnotes) {
            return new documents.Footnotes(_.indexBy(footnotes, "id"));
        });
    }

    function readXmlElements(elements) {
        var results = elements.map(readXmlElement);
        return Result.combine(results);
    }

    function readXmlElement(element) {
        if (element.type === "element") {
            var handler = xmlElementReaders[element.name];
            if (handler) {
                return handler(element);
            } else if (!Object.prototype.hasOwnProperty.call(ignoreElements, element.name)) {
                return new Result(
                    [],
                    [warning("An unrecognised element was ignored: " + element.name)]
                );
            }
        }
        return new Result([]);
    }
    
    function readRunProperties(element) {
        var properties = {
            type: "runProperties"
        };
        
        readRunStyle(properties, element);
        
        var verticalAlignmentElement = element.first("w:vertAlign");
        if (verticalAlignmentElement) {
            properties.verticalAlignment = verticalAlignmentElement.attributes["w:val"];
        }
        
        properties.isBold = !!element.first("w:b");
        properties.isUnderline = !!element.first("w:u");
        properties.isItalic = !!element.first("w:i");
        
        return new Result(properties);
    }
    
    function readRunStyle(properties, element) {
        var styleElement = element.first("w:rStyle");
        if (styleElement) {
            var styleId = styleElement.attributes["w:val"];
            properties.styleId = styleId;
            if (styleId) {
                var style = styles.findCharacterStyleById(styleId);
                properties.styleName = style.name;
            }
        }
    }
    
    function readChildElements(element) {
        return readXmlElements(element.children);
    }
    
    var xmlElementReaders = {
        "w:p": function(element) {
            return readXmlElements(element.children)
                .map(function(children) {
                    var properties = _.find(children, isParagraphProperties);
                    return new documents.Paragraph(
                        children.filter(negate(isParagraphProperties)),
                        properties
                    );
                });
        },
        "w:pPr": function(element) {
            var properties = {
                type: "paragraphProperties"
            };
            
            var styleElement = element.first("w:pStyle");
            if (styleElement) {
                var styleId = styleElement.attributes["w:val"];
                properties.styleId = styleId;
                if (styleId) {
                    var style = styles.findParagraphStyleById(styleId);
                    properties.styleName = style.name;
                }
            }
            var alignElement = element.first("w:jc");
            if (alignElement) {
                properties.alignment = alignElement.attributes["w:val"];
            }
            var numberingPropertiesElement = element.first("w:numPr");
            if (numberingPropertiesElement) {
                var levelElement = numberingPropertiesElement.first("w:ilvl");
                var level = levelElement.attributes["w:val"];
                var numId = numberingPropertiesElement.first("w:numId").attributes["w:val"];
                properties.numbering = numbering.findLevel(numId, level);
            }
            
            return new Result(properties);
        },
        "w:r": function(element) {
            return readXmlElements(element.children)
                .map(function(children) {
                    var properties = _.find(children, isRunProperties);
                    
                    return new documents.Run(
                        children.filter(negate(isRunProperties)),
                        properties
                    );
                });
        },
        "w:rPr": readRunProperties,
        "w:t": function(element) {
            return new Result(new documents.Text(element.text()));
        },
        "w:tab": function(element) {
            return new Result(new documents.Tab());
        },
        "w:hyperlink": function(element) {
            var relationshipId = element.attributes["r:id"];
            return readXmlElements(element.children).map(function(children) {
                if (relationshipId) {
                    var href = relationships[relationshipId].target;
                    return new documents.Hyperlink(children, {href: href});
                } else {
                    return children;
                }
            });
        },
        "w:tbl": function(element) {
            return readXmlElements(element.children).map(documents.Table);
        },
        "w:tr": function(element) {
            return readXmlElements(element.children).map(documents.TableRow);
        },
        "w:tc": function(element) {
            return readXmlElements(element.children).map(documents.TableCell);
        },
        "w:footnoteReference": function(element) {
            var footnoteId = element.attributes["w:id"];
            return new Result(new documents.FootnoteReference({
                footnoteId: footnoteId
            }));
        },
        "w:br": function(element) {
            var breakType = element.attributes["w:type"];
            if (breakType) {
                return new Result([], [warning("Unsupported break type: " + breakType)]);
            } else {
                return new Result(new documents.LineBreak());
            }
        },
        
        "w:ins": readChildElements,
        "w:smartTag": readChildElements,
        "w:drawing": readChildElements,
        "wp:inline": readDrawingElement,
        "wp:anchor": readDrawingElement
    };
    return {
        convertXmlToDocument: convertXmlToDocument,
        readXmlElement: readXmlElement
    };

    function readDrawingElement(element) {
        var blips = element
            .getElementsByTagName("a:graphic")
            .getElementsByTagName("a:graphicData")
            .getElementsByTagName("pic:pic")
            .getElementsByTagName("pic:blipFill")
            .getElementsByTagName("a:blip");
        
        var results = blips.map(function(blip) {
            var relationshipId = blip.attributes["r:embed"];
            var imagePath = joinZipPath("word", relationships[relationshipId].target);
            var readImage = docxFile.read.bind(docxFile, imagePath);
            var altText = element.first("wp:docPr").attributes.descr;
            
            var image = documents.Image({
                readImage: readImage,
                altText: altText,
                contentType: contentTypes.findContentType(imagePath)
            });
            return new Result(image);
        });
        
        return Result.combine(results);
    }
}

var ignoreElements = {
    "w:bookmarkStart": true,
    "w:bookmarkEnd": true,
    "w:sectPr": true,
    "w:proofErr": true,
    "w:lastRenderedPageBreak": true,
    "w:commentRangeStart": true,
    "w:commentRangeEnd": true,
    "w:commentReference": true,
    "w:del": true,
    "w:footnoteRef": true,
    "w:tblPr": true,
    "w:tblGrid": true,
    "w:tcPr": true
};

function isParagraphProperties(element) {
    return element.type === "paragraphProperties";
}

function isRunProperties(element) {
    return element.type === "runProperties";
}

function negate(predicate) {
    return function(value) {
        return !predicate(value);
    };
}

function joinZipPath(first, second) {
    // In general, we should check first and second for trailing and leading slashes,
    // but in our specific case this seems to be sufficient
    return first + "/" + second;
}
